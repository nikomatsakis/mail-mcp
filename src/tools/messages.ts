import type { ImapFlow, SearchObject } from "imapflow";
import { z } from "zod";
import { parseWhen } from "../dates.js";
import { decodeText, describeFlags, formatAddresses, parseReferences, truncate } from "../mime.js";
import {
  compact,
  defineTool,
  folderShape,
  json,
  pagingShape,
  uidShape,
  type ToolContext,
} from "./helpers.js";

/** The search arguments, shared by mail_search and reused by the bulk actions. */
export const searchShape = {
  from: z.string().optional().describe("Substring of the From header: a name or an address"),
  to: z.string().optional().describe("Substring of the To header"),
  cc: z.string().optional().describe("Substring of the Cc header"),
  subject: z.string().optional().describe("Substring of the subject"),
  body: z.string().optional().describe("Text to look for in the message body"),
  text: z.string().optional().describe("Text to look for anywhere — headers and body together"),
  since: z
    .string()
    .optional()
    .describe("Only messages received on or after this: `2026-08-01`, `7d`, `yesterday`"),
  before: z.string().optional().describe("Only messages received before this date"),
  unread_only: z.boolean().optional().describe("Only messages that have not been read"),
  flagged_only: z.boolean().optional().describe("Only flagged (starred) messages"),
  answered: z.boolean().optional().describe("true = only replied-to messages, false = only not replied to"),
  larger_than: z.number().int().optional().describe("Only messages larger than this many bytes"),
  smaller_than: z.number().int().optional().describe("Only messages smaller than this many bytes"),
  has_attachment: z
    .boolean()
    .optional()
    .describe("Only messages carrying a real attachment (checked after the server search)"),
  header: z
    .record(z.string())
    .optional()
    .describe('Match arbitrary headers, e.g. {"List-Id": "announce"}'),
};

type SearchArgs = {
  [K in keyof typeof searchShape]?: K extends "header"
    ? Record<string, string>
    : K extends "unread_only" | "flagged_only" | "answered" | "has_attachment"
      ? boolean
      : K extends "larger_than" | "smaller_than"
        ? number
        : string;
};

/** Translates the tool arguments into an IMAP SEARCH query. */
export function buildCriteria(args: SearchArgs): SearchObject {
  const criteria: SearchObject = compact({
    from: args.from,
    to: args.to,
    cc: args.cc,
    subject: args.subject,
    body: args.body,
    text: args.text,
    since: parseWhen(args.since),
    before: parseWhen(args.before),
    seen: args.unread_only ? false : undefined,
    flagged: args.flagged_only ? true : undefined,
    answered: args.answered,
    larger: args.larger_than,
    smaller: args.smaller_than,
    header: args.header,
  });
  // An empty query is invalid IMAP; ALL is what "no filter" means.
  return Object.keys(criteria).length > 0 ? criteria : { all: true };
}

export function registerMessageTools(ctx: ToolContext): void {
  const { client } = ctx;

  defineTool(
    ctx,
    "mail_list_messages",
    {
      ...folderShape,
      ...pagingShape,
      unread_only: z.boolean().optional().describe("Only messages that have not been read"),
      with_preview: z
        .boolean()
        .optional()
        .describe("Include the first few lines of each message — slower, but often enough to answer"),
    },
    {
      title: "List messages",
      description:
        "The newest messages in a folder, most recent first: sender, subject, date, flags and " +
        "whether anything is attached. This is the normal way to look at a mailbox; use " +
        "mail_search when you have something specific to find.",
      readOnly: true,
    },
    async (args) => {
      const limit = args.limit ?? 25;
      return client.withFolder(
        args.folder ?? ctx.config.defaultFolder,
        async (imap, path) => {
          const { uids, total } = await client.searchUids(
            imap,
            args.unread_only ? { seen: false } : { all: true },
            limit,
            args.offset ?? 0,
          );
          const messages = await client.summaries(imap, path, uids, { preview: args.with_preview });
          return json({
            folder: path,
            total_matching: total,
            returned: messages.length,
            offset: args.offset ?? 0,
            messages,
          });
        },
        { readOnly: true },
      );
    },
  );

  defineTool(
    ctx,
    "mail_search",
    {
      ...folderShape,
      ...searchShape,
      ...pagingShape,
      with_preview: z.boolean().optional().describe("Include the first few lines of each match"),
    },
    {
      title: "Search messages",
      description:
        "Searches one folder with the server's own index: sender, recipient, subject, body text, " +
        "date range, read state, size and arbitrary headers, combined with AND. Results come " +
        "back newest first. Substring matching is what IMAP offers — `from: \"anna\"` matches " +
        "anna@, Anna Petrova and hannah@ alike.",
      readOnly: true,
    },
    async (args) => {
      const limit = args.limit ?? 25;
      const criteria = buildCriteria(args);

      return client.withFolder(
        args.folder ?? ctx.config.defaultFolder,
        async (imap, path) => {
          // Attachment filtering happens here rather than on the server: IMAP has
          // no such criterion, so extra candidates are fetched and then dropped.
          const overfetch = args.has_attachment ? Math.min(limit * 4, 200) : limit;
          const { uids, total } = await client.searchUids(imap, criteria, overfetch, args.offset ?? 0);
          let messages = await client.summaries(imap, path, uids, { preview: args.with_preview });
          if (args.has_attachment) {
            messages = messages.filter((message) => message.has_attachments).slice(0, limit);
          }
          return json({
            folder: path,
            criteria: describeCriteria(criteria),
            total_matching: total,
            returned: messages.length,
            messages,
            note:
              args.has_attachment && total > overfetch
                ? "The attachment filter was applied to the newest matches only; narrow the search for older mail."
                : undefined,
          });
        },
        { readOnly: true },
      );
    },
  );

  defineTool(
    ctx,
    "mail_read_message",
    {
      ...folderShape,
      ...uidShape,
      format: z
        .enum(["text", "html", "both"])
        .optional()
        .describe(
          "Which body to return. `text` (default) prefers the plain-text part and flattens HTML " +
            "when there is none; `html` returns the HTML source; `both` returns each",
        ),
      mark_read: z.boolean().optional().describe("Mark the message as read (default false)"),
      max_chars: z.number().int().min(500).optional().describe("Cap for the body length"),
    },
    {
      title: "Read a message",
      description:
        "The full message: headers, the readable body, and the list of attachments with the " +
        "part ids mail_read_attachment needs. Only the body part is downloaded, so a message " +
        "with a large attachment is still cheap to read. Reading does not mark anything as read " +
        "unless you ask it to.",
      readOnly: true,
    },
    async (args) => {
      const limit = args.max_chars ?? ctx.config.maxBodyChars;
      return client.withFolder(
        args.folder ?? ctx.config.defaultFolder,
        async (imap, path) => {
          const message = await imap.fetchOne(
            String(args.uid),
            { uid: true, envelope: true, flags: true, size: true, bodyStructure: true, headers: true },
            { uid: true },
          );
          if (!message) {
            throw new Error(
              `No message with UID ${args.uid} in \`${path}\`. UIDs belong to one folder — a ` +
                "message that was moved has a different one there.",
            );
          }

          const summary = client.toSummary(path, message);
          const attachments = message.bodyStructure
            ? client.collectAttachments(message.bodyStructure)
            : [];

          const wantsText = args.format !== "html";
          const body = wantsText
            ? await client.readBody(imap, args.uid, message.bodyStructure, limit)
            : undefined;

          let html: string | undefined;
          if (args.format === "html" || args.format === "both") {
            html = await readHtmlSource(client, imap, args.uid, message.bodyStructure, limit);
          }

          if (args.mark_read && !ctx.config.readOnly) {
            await imap.messageFlagsAdd(String(args.uid), ["\\Seen"], { uid: true });
          }

          const headers = message.headers ? parseHeaders(message.headers) : {};
          const envelope = message.envelope ?? {};

          return json({
            ...summary,
            reply_to: formatAddresses(envelope.replyTo),
            bcc: formatAddresses(envelope.bcc),
            in_reply_to: envelope.inReplyTo,
            references: parseReferences(headers["references"]),
            list_id: headers["list-id"],
            body_format: body?.format,
            body: body?.text,
            body_html: html,
            truncated: body?.truncated || undefined,
            attachments: attachments.length ? attachments : undefined,
            marked_read: args.mark_read && !ctx.config.readOnly ? true : undefined,
          });
        },
        { readOnly: !args.mark_read },
      );
    },
  );

  defineTool(
    ctx,
    "mail_read_thread",
    {
      ...folderShape,
      ...uidShape,
      include_bodies: z
        .boolean()
        .optional()
        .describe("Include each message's body, not just the headers (default true)"),
      max_messages: z.number().int().min(1).max(50).optional().describe("Cap on messages (default 20)"),
      max_chars: z.number().int().min(200).optional().describe("Body cap per message (default 4000)"),
    },
    {
      title: "Read a conversation",
      description:
        "Collects the whole exchange a message belongs to and returns it oldest first, so the " +
        "conversation reads in order. Messages are matched by Message-ID references first and " +
        "by subject as a fallback, and the search covers the folder plus Sent, so your own " +
        "replies are part of the thread rather than missing from it.",
      readOnly: true,
    },
    async (args) => {
      const limit = args.max_messages ?? 20;
      const bodyLimit = args.max_chars ?? 4000;
      const folder = await client.resolveFolder(args.folder);

      // Anchor: the message the caller pointed at, and the ids that identify its thread.
      const anchor = await client.withFolder(
        folder,
        async (imap) => {
          const message = await imap.fetchOne(
            String(args.uid),
            { uid: true, envelope: true, headers: ["message-id", "in-reply-to", "references"] },
            { uid: true },
          );
          if (!message) throw new Error(`No message with UID ${args.uid} in \`${folder}\`.`);
          const headers = message.headers ? parseHeaders(message.headers) : {};
          return {
            messageId: message.envelope?.messageId,
            subject: message.envelope?.subject,
            references: [
              ...parseReferences(headers["references"]),
              ...parseReferences(headers["in-reply-to"]),
              message.envelope?.messageId,
            ].filter((id): id is string => Boolean(id)),
          };
        },
        { readOnly: true },
      );

      const sent = await client.specialFolder("\\Sent");
      const folders = [folder, ...(sent && sent !== folder ? [sent] : [])];
      const collected: Record<string, unknown>[] = [];

      for (const path of folders) {
        try {
          client.assertFolderAllowed(path);
        } catch {
          continue; // an allowlist that omits Sent simply narrows the thread
        }
        await client.withFolder(
          path,
          async (imap, resolved) => {
            const criteria: SearchObject =
              anchor.references.length > 0
                ? {
                    or: [
                      ...anchor.references.map((id) => ({ header: { "message-id": id } })),
                      ...anchor.references.map((id) => ({ header: { references: id } })),
                      ...anchor.references.map((id) => ({ header: { "in-reply-to": id } })),
                    ],
                  }
                : { subject: anchor.subject ?? "" };

            const found = await client
              .searchUids(imap, criteria, limit)
              // Servers differ in how much of SEARCH HEADER they implement; a
              // subject match is a poor thread but a better answer than an error.
              .catch(() => client.searchUids(imap, { subject: anchor.subject ?? "" }, limit));

            const summaries = await client.summaries(imap, resolved, found.uids);
            for (const summary of summaries) {
              const entry: Record<string, unknown> = { ...summary };
              if (args.include_bodies !== false) {
                const message = await imap.fetchOne(
                  String(summary.uid),
                  { uid: true, bodyStructure: true },
                  { uid: true },
                );
                const body = message
                  ? await client.readBody(imap, summary.uid, message.bodyStructure, bodyLimit)
                  : undefined;
                entry.body = body?.text;
              }
              collected.push(entry);
            }
          },
          { readOnly: true },
        );
      }

      // Oldest first, and the same message found in two folders counted once.
      const seen = new Set<string>();
      const ordered = collected
        .filter((entry) => {
          const key = String(entry.message_id ?? `${entry.folder}:${entry.uid}`);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => {
          const at = Date.parse(String(a.date ?? "")) || 0;
          const bt = Date.parse(String(b.date ?? "")) || 0;
          // Messages sent within the same second carry the same Date header, and
          // the search that found them returns newest first — so without the UID
          // tiebreak a fast exchange comes out in reverse.
          return at !== bt ? at - bt : Number(a.uid ?? 0) - Number(b.uid ?? 0);
        })
        .slice(0, limit);

      return json({
        subject: anchor.subject,
        searched_folders: folders,
        count: ordered.length,
        messages: ordered,
      });
    },
  );

  defineTool(
    ctx,
    "mail_get_raw_message",
    {
      ...folderShape,
      ...uidShape,
      headers_only: z.boolean().optional().describe("Return only the header block (default false)"),
      max_bytes: z.number().int().min(1000).optional().describe("Cap on the download (default 100000)"),
    },
    {
      title: "Raw message source",
      description:
        "The message exactly as it arrived, headers and MIME structure included. This is what " +
        "answers questions the parsed view cannot: SPF and DKIM results, Received chains, " +
        "mailing-list headers, why a message looks like spam.",
      readOnly: true,
    },
    async (args) => {
      const maxBytes = args.max_bytes ?? 100_000;
      return client.withFolder(
        args.folder ?? ctx.config.defaultFolder,
        async (imap, path) => {
          const message = await imap.fetchOne(
            String(args.uid),
            args.headers_only
              ? { uid: true, headers: true }
              : { uid: true, source: { maxLength: maxBytes } },
            { uid: true },
          );
          if (!message) throw new Error(`No message with UID ${args.uid} in \`${path}\`.`);
          const bytes = args.headers_only ? message.headers : message.source;
          const raw = bytes ? decodeText(bytes) : "";
          const result = truncate(raw, maxBytes);
          return json({ folder: path, uid: args.uid, source: result.text });
        },
        { readOnly: true },
      );
    },
  );
}

/** Reads the HTML part as source rather than flattening it. */
async function readHtmlSource(
  client: ToolContext["client"],
  imap: ImapFlow,
  uid: number,
  structure: Parameters<ToolContext["client"]["collectAttachments"]>[0] | undefined,
  limit: number,
): Promise<string | undefined> {
  if (!structure) return undefined;
  const html = findHtmlPart(structure);
  if (!html) return undefined;
  const payload = await client.downloadPart(imap, uid, html);
  return truncate(decodeText(payload.bytes, payload.charset), limit).text;
}

function findHtmlPart(node: { type?: string; part?: string; childNodes?: unknown[] }): string | undefined {
  const children = (node.childNodes ?? []) as typeof node[];
  for (const child of children) {
    const found = findHtmlPart(child);
    if (found) return found;
  }
  if (children.length === 0 && /^text\/html$/i.test(node.type ?? "")) return node.part ?? "1";
  return undefined;
}

/** Header block into a lower-cased lookup, folded continuation lines joined. */
function parseHeaders(raw: Buffer): Record<string, string> {
  const headers: Record<string, string> = {};
  const unfolded = raw.toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    // Received appears many times; the first (most recent) hop is the useful one.
    headers[key] ??= value;
  }
  return headers;
}

/** Echoes back what was actually searched for, since IMAP silently ignores nothing. */
function describeCriteria(criteria: SearchObject): Record<string, unknown> {
  const readable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(criteria)) {
    readable[key] = value instanceof Date ? value.toISOString() : value;
  }
  return readable;
}

export { describeFlags };
