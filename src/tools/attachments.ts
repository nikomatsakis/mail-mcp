import { z } from "zod";
import { decodeText, truncate } from "../mime.js";
import { blocks, defineTool, folderShape, json, uidShape, type ToolContext } from "./helpers.js";

/** Image types a model can actually look at, rather than merely receive. */
const VIEWABLE_IMAGES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);

/** Types worth handing over as text even though they are attached as files. */
const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|csv|sql)|message\/rfc822)/i;

export function registerAttachmentTools(ctx: ToolContext): void {
  const { client } = ctx;

  defineTool(
    ctx,
    "mail_list_attachments",
    { ...folderShape, ...uidShape },
    {
      title: "List attachments",
      description:
        "Everything attached to a message — filename, type, size and the `part` id needed to " +
        "download it — without fetching the message body. Inline parts (images embedded in the " +
        "HTML) are marked as such, so a signature logo is not mistaken for a document.",
      readOnly: true,
    },
    async (args) =>
      client.withFolder(
        args.folder ?? ctx.config.defaultFolder,
        async (imap, path) => {
          const message = await imap.fetchOne(
            String(args.uid),
            { uid: true, envelope: true, bodyStructure: true },
            { uid: true },
          );
          if (!message) throw new Error(`No message with UID ${args.uid} in \`${path}\`.`);
          const attachments = message.bodyStructure
            ? client.collectAttachments(message.bodyStructure)
            : [];
          return json({
            folder: path,
            uid: args.uid,
            subject: message.envelope?.subject,
            count: attachments.length,
            attachments,
            note: attachments.length
              ? "Read one with mail_read_attachment, passing the `part` value."
              : "This message has no attachments.",
          });
        },
        { readOnly: true },
      ),
  );

  defineTool(
    ctx,
    "mail_read_attachment",
    {
      ...folderShape,
      ...uidShape,
      part: z
        .string()
        .optional()
        .describe("Part id from mail_list_attachments, e.g. `2` or `2.1`. Omit when using `filename`"),
      filename: z
        .string()
        .optional()
        .describe("Pick the attachment by name instead of by part id — matched case-insensitively"),
      as_text: z
        .boolean()
        .optional()
        .describe("Force textual handling for a file the server labelled as binary"),
    },
    {
      title: "Read an attachment",
      description:
        "Downloads one attachment and hands it over in the most useful form: PNG, JPEG, GIF and " +
        "WebP come back as an image the assistant can actually look at, text and CSV and JSON as " +
        "text, anything else as a base64 resource. This is how a screenshot someone mailed you " +
        "gets read rather than merely mentioned.",
      readOnly: true,
    },
    async (args) => {
      if (!args.part && !args.filename) {
        throw new Error("Give either `part` (from mail_list_attachments) or `filename`.");
      }

      return client.withFolder(
        args.folder ?? ctx.config.defaultFolder,
        async (imap, path) => {
          const message = await imap.fetchOne(
            String(args.uid),
            { uid: true, bodyStructure: true },
            { uid: true },
          );
          if (!message || !message.bodyStructure) {
            throw new Error(`No message with UID ${args.uid} in \`${path}\`.`);
          }

          const attachments = client.collectAttachments(message.bodyStructure);
          const wanted = args.part
            ? attachments.find((attachment) => attachment.part === args.part)
            : attachments.find(
                (attachment) =>
                  attachment.filename.toLowerCase() === args.filename?.trim().toLowerCase(),
              ) ??
              attachments.find((attachment) =>
                attachment.filename.toLowerCase().includes(args.filename?.trim().toLowerCase() ?? ""),
              );

          if (!wanted) {
            const available = attachments.map((attachment) => `${attachment.part} ${attachment.filename}`);
            throw new Error(
              `No such attachment on message ${args.uid}. Available: ${available.join(", ") || "none"}.`,
            );
          }

          const payload = await client.downloadPart(imap, args.uid, wanted.part);
          const label =
            `${wanted.filename} — ${payload.contentType}, ${payload.bytes.byteLength} bytes ` +
            `(message ${args.uid} in ${path})`;

          if (VIEWABLE_IMAGES.has(payload.contentType.toLowerCase()) && !args.as_text) {
            return blocks([
              { type: "text", text: label },
              {
                type: "image",
                data: payload.bytes.toString("base64"),
                mimeType: payload.contentType.toLowerCase(),
              },
            ]);
          }

          if (args.as_text || TEXTUAL.test(payload.contentType)) {
            const body = truncate(
              decodeText(payload.bytes, payload.charset),
              ctx.config.maxBodyChars,
            );
            return blocks([{ type: "text", text: `${label}\n\n${body.text}` }]);
          }

          // Everything else travels as a resource: a PDF or a spreadsheet is worth
          // handing over intact even when it cannot be displayed inline.
          return blocks([
            { type: "text", text: label },
            {
              type: "resource",
              resource: {
                uri: `mail://${encodeURIComponent(path)}/${args.uid}/${wanted.part}/${encodeURIComponent(wanted.filename)}`,
                mimeType: payload.contentType,
                blob: payload.bytes.toString("base64"),
              },
            },
          ]);
        },
        { readOnly: true },
      );
    },
  );
}
