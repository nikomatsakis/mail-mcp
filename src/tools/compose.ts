import { z } from "zod";
import { formatAddress, formatAddresses, forwardSubject, parseReferences, quote, replySubject } from "../mime.js";
import type { SendOptions } from "../mail-client.js";
import { defineTool, folderShape, json, uidShape, type ToolContext } from "./helpers.js";

const attachmentShape = z.object({
  filename: z.string().optional().describe("Name the recipient sees; taken from `path` when omitted"),
  path: z
    .string()
    .optional()
    .describe("File on the machine running this server. Unavailable on a hosted deployment"),
  content_base64: z.string().optional().describe("File contents, base64 encoded"),
  content_type: z.string().optional().describe("MIME type; guessed from the name when omitted"),
});

const bodyShape = {
  text: z.string().optional().describe("Plain-text body. Give this, `html`, or both"),
  html: z.string().optional().describe("HTML body. Supply `text` alongside it for clients that prefer plain text"),
  attachments: z.array(attachmentShape).optional().describe("Files to attach"),
  headers: z.record(z.string()).optional().describe("Extra headers, e.g. {\"X-Priority\": \"1\"}"),
};

export function registerComposeTools(ctx: ToolContext): void {
  const { client } = ctx;

  defineTool(
    ctx,
    "mail_send",
    {
      to: z.string().describe("Recipients, comma separated: `a@b.com, Name <c@d.com>`"),
      subject: z.string().describe("Subject line"),
      cc: z.string().optional().describe("Carbon copy recipients, comma separated"),
      bcc: z.string().optional().describe("Blind copy recipients, comma separated"),
      reply_to: z.string().optional().describe("Address replies should go to, if not the sender"),
      ...bodyShape,
    },
    {
      title: "Send an email",
      description:
        "Composes and sends a new message from the configured address, then files a copy in the " +
        "Sent folder. The From address is fixed by the deployment and cannot be overridden by an " +
        "argument. When MAIL_ALLOWED_RECIPIENTS is set, every recipient is checked against it " +
        "before anything leaves the machine.",
    },
    async (args) => sendAndFile(ctx, args, "Sent."),
  );

  defineTool(
    ctx,
    "mail_reply",
    {
      ...folderShape,
      ...uidShape,
      reply_all: z.boolean().optional().describe("Also reply to everyone in To and Cc (default false)"),
      quote_original: z
        .boolean()
        .optional()
        .describe("Append the quoted original under your text (default true)"),
      to: z.string().optional().describe("Override the recipients entirely"),
      cc: z.string().optional().describe("Additional carbon copy recipients"),
      subject: z.string().optional().describe("Override the subject; defaults to `Re: <original>`"),
      ...bodyShape,
    },
    {
      title: "Reply to a message",
      description:
        "Replies in the same conversation: the In-Reply-To and References headers are carried " +
        "over, so the answer threads properly in the recipient's client instead of starting a " +
        "new conversation. Recipients default to the Reply-To or From of the original, and " +
        "`reply_all` adds everyone else it was addressed to, minus your own address.",
    },
    async (args) => {
      const original = await loadOriginal(ctx, args.folder, args.uid);

      const primary = args.to ?? (original.replyTo[0] ?? original.from);
      if (!primary) throw new Error("The original message has no usable sender address.");

      let cc = args.cc;
      if (args.reply_all) {
        const others = [...original.to, ...original.cc].filter(
          (address) => !sameAddress(address, ctx.config.fromAddress) && !sameAddress(address, primary),
        );
        cc = [args.cc, ...others].filter(Boolean).join(", ") || undefined;
      }

      const body = args.quote_original === false ? args.text : withQuote(args.text, original);

      return sendAndFile(
        ctx,
        {
          to: primary,
          cc,
          subject: args.subject ?? replySubject(original.subject),
          text: body,
          html: args.html,
          attachments: args.attachments,
          headers: args.headers,
          inReplyTo: original.messageId,
          references: [...original.references, original.messageId].filter(
            (id): id is string => Boolean(id),
          ),
        },
        "Reply sent.",
        // Marking the original as answered is what every mail client does, and it
        // is how you later tell handled mail from mail still waiting.
        { markAnswered: { folder: original.folder, uid: args.uid } },
      );
    },
  );

  defineTool(
    ctx,
    "mail_forward",
    {
      ...folderShape,
      ...uidShape,
      to: z.string().describe("Who to forward it to, comma separated"),
      cc: z.string().optional(),
      subject: z.string().optional().describe("Defaults to `Fwd: <original>`"),
      comment: z.string().optional().describe("Your note, placed above the forwarded message"),
      include_attachments: z
        .boolean()
        .optional()
        .describe("Carry the original attachments along (default true)"),
    },
    {
      title: "Forward a message",
      description:
        "Forwards a message with the usual header block — from, date, subject, to — above the " +
        "quoted original. Attachments are re-fetched and carried along unless you turn that off.",
    },
    async (args) => {
      const original = await loadOriginal(ctx, args.folder, args.uid, { withAttachments: true });

      const header = [
        "---------- Forwarded message ----------",
        `From: ${original.from}`,
        original.date ? `Date: ${original.date}` : undefined,
        `Subject: ${original.subject}`,
        original.to.length ? `To: ${original.to.join(", ")}` : undefined,
        original.cc.length ? `Cc: ${original.cc.join(", ")}` : undefined,
        "",
      ]
        .filter((line) => line !== undefined)
        .join("\n");

      const attachments =
        args.include_attachments === false
          ? undefined
          : await loadOriginalAttachments(ctx, original.folder, args.uid);

      return sendAndFile(
        ctx,
        {
          to: args.to,
          cc: args.cc,
          subject: args.subject ?? forwardSubject(original.subject),
          text: `${args.comment ? `${args.comment}\n\n` : ""}${header}\n${original.body}`,
          attachments,
        },
        "Forwarded.",
      );
    },
  );

  defineTool(
    ctx,
    "mail_save_draft",
    {
      to: z.string().optional().describe("Recipients, comma separated — a draft may have none yet"),
      subject: z.string().describe("Subject line"),
      cc: z.string().optional(),
      bcc: z.string().optional(),
      folder: z.string().optional().describe("Where to file it; defaults to the Drafts folder"),
      ...bodyShape,
    },
    {
      title: "Save a draft",
      description:
        "Writes a message into the Drafts folder without sending it — the right move when the " +
        "text should be reviewed in a mail client before it goes out. It appears as a normal " +
        "editable draft.",
    },
    async (args) => {
      const { raw } = await client.compose({
        // A draft is allowed to have no recipient yet; compose insists on one, so
        // a placeholder stands in and is stripped from the headers we build.
        to: args.to || ctx.config.fromAddress,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        text: args.text,
        html: args.html,
        attachments: args.attachments,
        headers: args.headers,
      });

      const target = args.folder ?? (await client.specialFolder("\\Drafts")) ?? "Drafts";
      const path = await client.appendMessage(raw, target, ["\\Draft", "\\Seen"]);
      if (!path) {
        throw new Error(
          "Could not file the draft: this account has no Drafts folder and one could not be " +
            "created. Name a folder explicitly with `folder`.",
        );
      }
      return json({
        saved: true,
        folder: path,
        subject: args.subject,
        to: args.to ?? null,
        note: "Saved as a draft — nothing has been sent.",
      });
    },
  );
}

interface Original {
  folder: string;
  from: string;
  replyTo: string[];
  to: string[];
  cc: string[];
  subject?: string;
  date?: string;
  messageId?: string;
  references: string[];
  body: string;
}

/** Loads the message a reply or forward is built from. */
async function loadOriginal(
  ctx: ToolContext,
  folder: string | undefined,
  uid: number,
  options: { withAttachments?: boolean } = {},
): Promise<Original> {
  const { client } = ctx;
  return client.withFolder(
    folder ?? ctx.config.defaultFolder,
    async (imap, path) => {
      const message = await imap.fetchOne(
        String(uid),
        { uid: true, envelope: true, bodyStructure: true, headers: ["references", "in-reply-to"] },
        { uid: true },
      );
      if (!message) throw new Error(`No message with UID ${uid} in \`${path}\`.`);

      const envelope = message.envelope ?? {};
      const raw = message.headers?.toString("utf8") ?? "";
      const references = [
        ...parseReferences(/^references:(.*)$/im.exec(raw)?.[1]),
        ...parseReferences(/^in-reply-to:(.*)$/im.exec(raw)?.[1]),
      ];

      const body = await client.readBody(
        imap,
        uid,
        message.bodyStructure,
        options.withAttachments ? ctx.config.maxBodyChars : 8000,
      );

      return {
        folder: path,
        from: formatAddresses(envelope.from)[0] ?? "",
        replyTo: formatAddresses(envelope.replyTo),
        to: formatAddresses(envelope.to),
        cc: formatAddresses(envelope.cc),
        subject: envelope.subject,
        date: envelope.date?.toISOString(),
        messageId: envelope.messageId,
        references,
        body: body.text,
      };
    },
    { readOnly: true },
  );
}

/** Re-fetches the attachments of a message so a forward carries them along. */
async function loadOriginalAttachments(
  ctx: ToolContext,
  folder: string,
  uid: number,
): Promise<{ filename: string; content_base64: string; content_type: string }[]> {
  const { client } = ctx;
  return client.withFolder(
    folder,
    async (imap) => {
      const message = await imap.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
      if (!message || !message.bodyStructure) return [];
      const attachments = client.collectAttachments(message.bodyStructure).filter((a) => !a.inline);

      const carried: { filename: string; content_base64: string; content_type: string }[] = [];
      let budget = ctx.config.maxAttachmentBytes;
      for (const attachment of attachments) {
        if ((attachment.size ?? 0) > budget) continue;
        const payload = await client.downloadPart(imap, uid, attachment.part);
        budget -= payload.bytes.byteLength;
        if (budget < 0) break;
        carried.push({
          filename: attachment.filename,
          content_base64: payload.bytes.toString("base64"),
          content_type: payload.contentType,
        });
      }
      return carried;
    },
    { readOnly: true },
  );
}

function withQuote(text: string | undefined, original: Original): string {
  const attribution = original.date
    ? `On ${new Date(original.date).toUTCString()}, ${original.from} wrote:`
    : `${original.from} wrote:`;
  return `${text ?? ""}\n\n${attribution}\n${quote(original.body)}`;
}

function sameAddress(a: string, b: string): boolean {
  const bare = (value: string) => (/<([^>]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();
  return bare(a) === bare(b);
}

/** Sends a composed message, files the Sent copy, and reports what happened. */
async function sendAndFile(
  ctx: ToolContext,
  options: SendOptions,
  headline: string,
  extras: { markAnswered?: { folder: string; uid: number } } = {},
): Promise<ReturnType<typeof json>> {
  const { client } = ctx;
  const { raw, to, messageId } = await client.compose(options);
  const result = await client.send(raw, to);

  let sentFolder: string | undefined;
  if (ctx.config.appendToSent) {
    const target = (await client.specialFolder("\\Sent")) ?? "Sent";
    // A missing or unwritable Sent folder must not turn a delivered message into
    // an error: the mail is already gone, and saying otherwise would be a lie.
    sentFolder = await client.appendMessage(raw, target).catch(() => undefined);
  }

  if (extras.markAnswered) {
    await client
      .withFolder(extras.markAnswered.folder, (imap) =>
        imap.messageFlagsAdd(String(extras.markAnswered!.uid), ["\\Answered"], { uid: true }),
      )
      .catch(() => undefined);
  }

  return json({
    sent: true,
    to: to.map((address) => formatAddress(address)),
    subject: options.subject,
    message_id: messageId,
    accepted: result.accepted,
    server_response: result.response,
    sent_copy: sentFolder ?? (ctx.config.appendToSent ? "could not be filed — no writable Sent folder" : "disabled"),
    size_bytes: raw.byteLength,
  }, headline);
}
