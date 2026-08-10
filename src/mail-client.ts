import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";
import {
  ImapFlow,
  type FetchMessageObject,
  type ListResponse,
  type MailboxLockObject,
  type MessageStructureObject,
  type SearchObject,
} from "imapflow";
import nodemailer, { type Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { connectionKey, type Config } from "./config.js";
import {
  decodeText,
  describeFlags,
  formatAddress,
  formatAddresses,
  htmlToText,
  isValidAddress,
  parseAddressList,
  truncate,
  unflow,
  type Address,
} from "./mime.js";

export class MailError extends Error {
  constructor(
    message: string,
    readonly stage: "imap" | "smtp" | "config" = "imap",
  ) {
    super(message);
    this.name = "MailError";
  }
}

/**
 * How long an authenticated IMAP connection is kept around after its last use.
 * Logging in costs a TLS handshake plus a round trip, and providers rate-limit
 * repeated logins hard — Gmail starts refusing after a few dozen per minute — so
 * a mailbox opened for one tool call stays warm for the next one. In stdio mode
 * this is the whole session; in HTTP mode it is shared across requests.
 */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface PooledConnection {
  client: ImapFlow;
  /** Serialises work on one connection: IMAP runs one command at a time. */
  chain: Promise<unknown>;
  timer: NodeJS.Timeout;
}

const pool = new Map<string, PooledConnection>();

/** Closes every pooled connection. Used when the process shuts down. */
export async function closeAllConnections(): Promise<void> {
  const entries = [...pool.entries()];
  pool.clear();
  await Promise.allSettled(
    entries.map(async ([, entry]) => {
      clearTimeout(entry.timer);
      try {
        await entry.client.logout();
      } catch {
        entry.client.close();
      }
    }),
  );
}

export interface MessageSummary {
  uid: number;
  folder: string;
  subject: string;
  from: string;
  to: string[];
  cc?: string[];
  date?: string;
  flags: string[];
  unread: boolean;
  has_attachments: boolean;
  size?: number;
  message_id?: string;
  preview?: string;
}

export interface AttachmentInfo {
  /** BODYSTRUCTURE part id, e.g. `2` or `2.1`; the handle used to download it. */
  part: string;
  filename: string;
  content_type: string;
  size?: number;
  /** Inline parts are usually images embedded in the HTML body rather than files. */
  inline: boolean;
  cid?: string;
}

export interface OutgoingAttachment {
  filename?: string;
  path?: string;
  content_base64?: string;
  content_type?: string;
}

export interface SendOptions {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: OutgoingAttachment[];
  headers?: Record<string, string>;
}

export class MailClient {
  private folderCache?: { at: number; folders: ListResponse[] };
  private transport?: Transporter;

  constructor(readonly config: Config) {}

  // --- connection ------------------------------------------------------------

  private buildClient(): ImapFlow {
    const { imap } = this.config;
    return new ImapFlow({
      host: imap.host,
      port: imap.port,
      secure: imap.secure,
      auth: imap.oauth2
        ? { user: imap.user, accessToken: imap.pass }
        : { user: imap.user, pass: imap.pass },
      tls: { rejectUnauthorized: this.config.rejectUnauthorized },
      // stdout is the MCP channel in stdio mode; a chatty client would corrupt it.
      logger: false,
      clientInfo: { name: "mail-mcp", version: "1.0.0" },
      // IDLE holds the connection in a state where the next command has to
      // interrupt it. Nothing here listens for new mail, so it only adds latency.
      disableAutoIdle: true,
      connectionTimeout: this.config.timeoutMs,
      greetingTimeout: Math.min(this.config.timeoutMs, 30_000),
      socketTimeout: Math.max(this.config.timeoutMs, IDLE_TIMEOUT_MS + 60_000),
    });
  }

  private touch(key: string, entry: PooledConnection): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      pool.delete(key);
      entry.client.logout().catch(() => entry.client.close());
    }, IDLE_TIMEOUT_MS);
    // An idle connection must not be the reason the process stays alive.
    entry.timer.unref?.();
  }

  private async connection(): Promise<PooledConnection> {
    const key = connectionKey(this.config);
    const existing = pool.get(key);
    if (existing?.client.usable) {
      this.touch(key, existing);
      return existing;
    }
    if (existing) {
      // Dropped by the server or by a network hiccup: replace it rather than fail.
      clearTimeout(existing.timer);
      pool.delete(key);
      existing.client.close();
    }

    const client = this.buildClient();
    client.on("error", () => {
      // Errors surface on the awaited command; this listener only keeps a
      // background socket failure from taking the process down.
    });

    try {
      await client.connect();
    } catch (error) {
      throw this.imapError(error);
    }

    const entry: PooledConnection = {
      client,
      chain: Promise.resolve(),
      timer: setTimeout(() => undefined, 0),
    };
    pool.set(key, entry);
    this.touch(key, entry);
    return entry;
  }

  /**
   * Runs `work` against a live connection, one caller at a time. The queue
   * matters because a single IMAP connection has one selected mailbox: two
   * overlapping tool calls would otherwise fight over which folder is open.
   */
  private async run<T>(work: (client: ImapFlow) => Promise<T>): Promise<T> {
    const entry = await this.connection();
    const result = entry.chain.then(
      () => work(entry.client),
      () => work(entry.client),
    );
    // The chain must never reject, or every later caller inherits the rejection.
    entry.chain = result.catch(() => undefined);
    try {
      return await result;
    } catch (error) {
      throw this.imapError(error);
    } finally {
      this.touch(connectionKey(this.config), entry);
    }
  }

  /** Opens a folder for the duration of `work`, releasing the lock afterwards. */
  async withFolder<T>(
    folder: string,
    work: (client: ImapFlow, path: string) => Promise<T>,
    options: { readOnly?: boolean } = {},
  ): Promise<T> {
    const path = await this.resolveFolder(folder);
    return this.run(async (client) => {
      let lock: MailboxLockObject | undefined;
      try {
        lock = await client.getMailboxLock(path, { readOnly: options.readOnly ?? false });
        return await work(client, path);
      } finally {
        lock?.release();
      }
    });
  }

  /** Runs work that needs no selected mailbox (LIST, STATUS, CREATE, …). */
  async withClient<T>(work: (client: ImapFlow) => Promise<T>): Promise<T> {
    return this.run(work);
  }

  private imapError(error: unknown): MailError {
    if (error instanceof MailError) return error;
    const raw = error as { message?: string; code?: string; authenticationFailed?: boolean };
    const message = raw?.message ?? String(error);
    const { imap, provider } = this.config;

    if (raw?.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(message)) {
      return new MailError(
        `IMAP rejected the credentials for ${imap.user} on ${imap.host}. ` +
          (provider?.authNote ??
            "Most providers refuse the account password over IMAP and require an app-specific " +
              "password, and many need IMAP access switched on in the web interface first.") +
          `\n\nServer said: ${message}`,
      );
    }
    if (raw?.code === "CONNECT_TIMEOUT" || /timed? out/i.test(message)) {
      return new MailError(
        `No answer from ${imap.host}:${imap.port} within ${this.config.timeoutMs}ms. ` +
          "Check the host name and port, and that the network allows the connection.",
      );
    }
    if (raw?.code === "ENOTFOUND" || /ENOTFOUND|EAI_AGAIN/i.test(message)) {
      return new MailError(`Unknown IMAP host \`${imap.host}\` — the name does not resolve.`);
    }
    if (raw?.code === "ECONNREFUSED" || /ECONNREFUSED/i.test(message)) {
      return new MailError(
        `${imap.host}:${imap.port} refused the connection. IMAP is usually 993 with TLS, ` +
          "or 143 with STARTTLS.",
      );
    }
    if (/certificate|self.signed|SSL|TLS/i.test(message) && this.config.rejectUnauthorized) {
      return new MailError(
        `TLS failed against ${imap.host}: ${message}. For an internal server with its own ` +
          "certificate authority, set MAIL_TLS_REJECT_UNAUTHORIZED=false.",
      );
    }
    return new MailError(message);
  }

  // --- folders ---------------------------------------------------------------

  /** Every folder in the account, cached briefly so a burst of calls lists once. */
  async listFolders(force = false): Promise<ListResponse[]> {
    if (!force && this.folderCache && Date.now() - this.folderCache.at < 60_000) {
      return this.folderCache.folders;
    }
    const folders = await this.run((client) => client.list());
    this.folderCache = { at: Date.now(), folders };
    return folders;
  }

  /** The folder carrying a special-use flag such as `\Sent`, if the server marks one. */
  async specialFolder(use: string): Promise<string | undefined> {
    const folders = await this.listFolders();
    const flag = use.startsWith("\\") ? use : `\\${use[0].toUpperCase()}${use.slice(1).toLowerCase()}`;
    return folders.find((folder) => folder.specialUse === flag)?.path;
  }

  /**
   * Resolves whatever the caller called a folder into a real IMAP path.
   *
   * "sent", "Sent", "[Gmail]/Sent Mail" and "Отправленные" all mean the same
   * mailbox, and which one exists depends on the provider and the account
   * language, so aliases resolve through the server's own special-use flags
   * before falling back to a name match.
   */
  async resolveFolder(input?: string): Promise<string> {
    const wanted = (input ?? this.config.defaultFolder).trim();
    const path = await this.resolveFolderPath(wanted);
    this.assertFolderAllowed(path);
    return path;
  }

  private async resolveFolderPath(wanted: string): Promise<string> {
    if (!wanted || wanted.toLowerCase() === "inbox") return "INBOX";

    const aliases: Record<string, string> = {
      sent: "\\Sent",
      sentmail: "\\Sent",
      sentitems: "\\Sent",
      draft: "\\Drafts",
      drafts: "\\Drafts",
      trash: "\\Trash",
      bin: "\\Trash",
      deleted: "\\Trash",
      deleteditems: "\\Trash",
      junk: "\\Junk",
      spam: "\\Junk",
      archive: "\\Archive",
      all: "\\All",
      allmail: "\\All",
      flagged: "\\Flagged",
      starred: "\\Flagged",
    };

    const folders = await this.listFolders();
    const key = wanted.toLowerCase().replace(/[\s_-]/g, "");
    const specialUse = aliases[key];
    if (specialUse) {
      const match = folders.find((folder) => folder.specialUse === specialUse);
      if (match) return match.path;
    }

    // Exact path, then case-insensitive path, then the last path segment.
    const exact = folders.find((folder) => folder.path === wanted);
    if (exact) return exact.path;
    const insensitive = folders.find(
      (folder) => folder.path.toLowerCase() === wanted.toLowerCase(),
    );
    if (insensitive) return insensitive.path;
    const byName = folders.filter((folder) => folder.name.toLowerCase() === wanted.toLowerCase());
    if (byName.length === 1) return byName[0].path;
    if (byName.length > 1) {
      throw new MailError(
        `\`${wanted}\` matches several folders: ${byName.map((f) => f.path).join(", ")}. ` +
          "Use the full path.",
      );
    }

    // Under an allowlist the suggestion must not name folders the caller is not
    // allowed to reach — the error would otherwise map the whole account.
    const known = folders
      .map((folder) => folder.path)
      .filter((path) => {
        if (this.config.allowedFolders.length === 0) return true;
        try {
          this.assertFolderAllowed(path);
          return true;
        } catch {
          return false;
        }
      })
      .join(", ");
    throw new MailError(
      `No folder \`${wanted}\` in this account. Available folders: ${known || "(none listed)"}.`,
    );
  }

  /** Refuses a folder outside MAIL_ALLOWED_FOLDERS, when that list is set. */
  assertFolderAllowed(path: string): void {
    const { allowedFolders } = this.config;
    if (allowedFolders.length === 0) return;
    const allowed = allowedFolders.some((entry) => {
      const candidate = entry.toLowerCase();
      const target = path.toLowerCase();
      // A listed folder covers its subfolders, whatever the server's delimiter is.
      return target === candidate || target.startsWith(`${candidate}/`) || target.startsWith(`${candidate}.`);
    });
    if (!allowed) {
      throw new MailError(
        `Refused: this server may only touch ${allowedFolders.join(", ")} ` +
          `(MAIL_ALLOWED_FOLDERS), so \`${path}\` is out of scope.`,
      );
    }
  }

  /**
   * Resolves a folder, creating it when it does not exist yet.
   *
   * Used for the folders a mail client takes for granted — Sent, Drafts, Trash.
   * A fresh account, or a server that only materialises them on first use, would
   * otherwise turn "save this as a draft" into an error about a missing folder,
   * which is not the user's problem to solve.
   */
  async resolveOrCreateFolder(input: string): Promise<string> {
    const existing = await this.resolveFolderPath(input).catch(() => undefined);
    if (existing) {
      this.assertFolderAllowed(existing);
      return existing;
    }
    const path = input.trim();
    this.assertFolderAllowed(path);
    await this.run((client) => client.mailboxCreate(path));
    this.clearFolderCache();
    return path;
  }

  /** Invalidate after a create/rename/delete so the next lookup sees the change. */
  clearFolderCache(): void {
    this.folderCache = undefined;
  }

  // --- reading ---------------------------------------------------------------

  /**
   * Newest-first UIDs matching a search, without pulling the whole result set.
   * IMAP returns matches in ascending UID order, which is oldest first — the
   * opposite of what anyone wants from a mailbox.
   */
  async searchUids(
    client: ImapFlow,
    criteria: SearchObject,
    limit: number,
    offset = 0,
  ): Promise<{ uids: number[]; total: number }> {
    const found = (await client.search(criteria, { uid: true })) as number[] | false;
    const all = Array.isArray(found) ? found : [];
    const newestFirst = [...all].reverse();
    return { uids: newestFirst.slice(offset, offset + limit), total: all.length };
  }

  /** Envelope-level view of a set of messages, in the order the UIDs were given. */
  async summaries(
    client: ImapFlow,
    folder: string,
    uids: number[],
    options: { preview?: boolean } = {},
  ): Promise<MessageSummary[]> {
    if (uids.length === 0) return [];
    const byUid = new Map<number, FetchMessageObject>();
    for await (const message of client.fetch(
      uids.join(","),
      { uid: true, envelope: true, flags: true, size: true, bodyStructure: true },
      { uid: true },
    )) {
      byUid.set(message.uid, message);
    }

    const summaries: MessageSummary[] = [];
    for (const uid of uids) {
      const message = byUid.get(uid);
      if (!message) continue;
      summaries.push(this.toSummary(folder, message));
    }

    if (options.preview) {
      // One extra fetch per message, so it is opt-in: worth it for a list the
      // model has to triage, wasteful when it only needs subjects.
      await Promise.all(
        summaries.map(async (summary) => {
          try {
            const body = await this.readBody(client, summary.uid, byUid.get(summary.uid)?.bodyStructure, 400);
            summary.preview = body.text.replace(/\s+/g, " ").slice(0, 300).trim() || undefined;
          } catch {
            // A preview is a nicety; a broken part must not fail the listing.
          }
        }),
      );
    }
    return summaries;
  }

  toSummary(folder: string, message: FetchMessageObject): MessageSummary {
    const envelope = message.envelope ?? {};
    const attachments = message.bodyStructure ? this.collectAttachments(message.bodyStructure) : [];
    return {
      uid: message.uid,
      folder,
      subject: envelope.subject ?? "(no subject)",
      from: formatAddresses(envelope.from)[0] ?? "(unknown sender)",
      to: formatAddresses(envelope.to),
      cc: formatAddresses(envelope.cc).length ? formatAddresses(envelope.cc) : undefined,
      date: envelope.date?.toISOString(),
      flags: describeFlags(message.flags),
      unread: !message.flags?.has("\\Seen"),
      has_attachments: attachments.some((attachment) => !attachment.inline),
      size: message.size,
      message_id: envelope.messageId,
    };
  }

  /** Walks BODYSTRUCTURE for the parts a person would call attachments. */
  collectAttachments(structure: MessageStructureObject): AttachmentInfo[] {
    const found: AttachmentInfo[] = [];

    const walk = (node: MessageStructureObject): void => {
      for (const child of node.childNodes ?? []) walk(child);
      if (node.childNodes?.length) return;
      if (!node.part) return; // the root of a single-part message is the body itself

      const disposition = node.disposition?.toLowerCase();
      const filename =
        node.dispositionParameters?.filename ?? node.parameters?.name ?? undefined;
      const isText = /^text\/(plain|html)$/i.test(node.type ?? "");

      // A part counts as an attachment when it says so, or when it is a named
      // non-text part — some senders omit Content-Disposition entirely.
      if (disposition !== "attachment" && disposition !== "inline" && (isText || !filename)) return;
      if (disposition === "inline" && isText && !filename) return;

      found.push({
        part: node.part,
        filename: filename ?? `part-${node.part}.${(node.type ?? "bin").split("/")[1] ?? "bin"}`,
        content_type: node.type ?? "application/octet-stream",
        size: node.size,
        inline: disposition === "inline",
        cid: node.id?.replace(/^<|>$/g, ""),
      });
    };

    walk(structure);
    return found;
  }

  /**
   * The readable body of a message: the text/plain part when there is one, the
   * HTML flattened to prose otherwise. Only the chosen part is downloaded, so a
   * message with a 20 MB attachment still costs a few kilobytes to read.
   */
  async readBody(
    client: ImapFlow,
    uid: number,
    structure: MessageStructureObject | undefined,
    limit: number,
  ): Promise<{ text: string; format: "text" | "html" | "none"; truncated: boolean }> {
    const parts = this.textParts(structure);
    const chosen = parts.plain ?? parts.html;
    if (!chosen) return { text: "", format: "none", truncated: false };

    const download = await client.download(String(uid), chosen.part, {
      uid: true,
      // Enough for a very long letter; attachments are not fetched here at all.
      maxBytes: Math.max(limit * 4, 256 * 1024),
    });
    const bytes = await streamToBuffer(download.content);
    let text = decodeText(bytes, download.meta.charset ?? chosen.parameters?.charset);

    if (chosen === parts.plain) {
      if (download.meta.flowed) text = unflow(text, download.meta.delSp);
    } else {
      text = htmlToText(text);
    }

    const result = truncate(text.trim(), limit);
    return {
      text: result.text,
      format: chosen === parts.plain ? "text" : "html",
      truncated: result.truncated,
    };
  }

  /** First text/plain and text/html parts that are body text rather than files. */
  private textParts(structure: MessageStructureObject | undefined): {
    plain?: MessageStructureObject;
    html?: MessageStructureObject;
  } {
    const result: { plain?: MessageStructureObject; html?: MessageStructureObject } = {};
    if (!structure) return result;

    const walk = (node: MessageStructureObject): void => {
      if (node.childNodes?.length) {
        // Do not descend into an attached message: its body is not this one's.
        if (/^message\/rfc822$/i.test(node.type ?? "")) return;
        for (const child of node.childNodes) walk(child);
        return;
      }
      const type = (node.type ?? "").toLowerCase();
      const disposition = node.disposition?.toLowerCase();
      if (disposition === "attachment") return;
      // `part` is undefined for the single node of a non-multipart message,
      // where the body is part 1 by definition.
      const part = node.part ?? "1";
      if (type === "text/plain" && !result.plain) result.plain = { ...node, part };
      if (type === "text/html" && !result.html) result.html = { ...node, part };
    };

    walk(structure);
    return result;
  }

  /** Downloads one body part, refusing anything above the configured ceiling. */
  async downloadPart(
    client: ImapFlow,
    uid: number,
    part: string,
  ): Promise<{ bytes: Buffer; contentType: string; filename?: string; charset?: string }> {
    const download = await client.download(String(uid), part, {
      uid: true,
      maxBytes: this.config.maxAttachmentBytes,
    });
    const bytes = await streamToBuffer(download.content);
    if (download.meta.expectedSize > this.config.maxAttachmentBytes) {
      throw new MailError(
        `The attachment is ${download.meta.expectedSize} bytes, above MAIL_MAX_ATTACHMENT_BYTES ` +
          `(${this.config.maxAttachmentBytes}). Raise the limit to read it.`,
      );
    }
    return {
      bytes,
      contentType: (download.meta.contentType ?? "application/octet-stream").split(";")[0].trim(),
      filename: download.meta.filename,
      charset: download.meta.charset,
    };
  }

  // --- sending ---------------------------------------------------------------

  private smtp(): Transporter {
    const { smtp } = this.config;
    if (!smtp) {
      throw new MailError(
        "Sending is not configured: no SMTP host is set and the address does not match a known " +
          "provider. Set the outgoing mail server to send mail.",
        "smtp",
      );
    }
    this.transport ??= nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.oauth2
        ? { type: "OAuth2", user: smtp.user, accessToken: smtp.pass }
        : { user: smtp.user, pass: smtp.pass },
      tls: { rejectUnauthorized: this.config.rejectUnauthorized },
      connectionTimeout: this.config.timeoutMs,
      greetingTimeout: Math.min(this.config.timeoutMs, 30_000),
      socketTimeout: this.config.timeoutMs,
      // One connection reused for a burst of messages, closed when idle.
      pool: true,
      maxConnections: 1,
    });
    return this.transport;
  }

  /**
   * Logs in to the submission server without sending anything. Worth doing on
   * its own: IMAP and SMTP are separate services that fail for separate reasons,
   * and a mailbox that reads perfectly can still be unable to send.
   */
  async verifySmtp(): Promise<void> {
    try {
      await this.smtp().verify();
    } catch (error) {
      throw this.smtpError(error);
    }
  }

  /** Drops the SMTP pool. Called when the server is torn down. */
  closeTransport(): void {
    this.transport?.close();
    this.transport = undefined;
  }

  /**
   * Refuses recipients outside MAIL_ALLOWED_RECIPIENTS. The check runs over the
   * final address list — To, Cc and Bcc together — so nothing slips through in a
   * field the caller hoped nobody was watching.
   */
  assertRecipientsAllowed(addresses: Address[]): void {
    const { allowedRecipients } = this.config;
    if (allowedRecipients.length === 0) return;
    const refused = addresses
      .map((entry) => entry.address.toLowerCase())
      .filter(
        (address) =>
          !allowedRecipients.some((allowed) =>
            allowed.startsWith("@") ? address.endsWith(allowed) : address === allowed,
          ),
      );
    if (refused.length > 0) {
      throw new MailError(
        `Refused: mail to ${refused.join(", ")} is outside MAIL_ALLOWED_RECIPIENTS ` +
          `(${allowedRecipients.join(", ")}).`,
        "smtp",
      );
    }
  }

  /** Reads the attachments a tool was given, from disk or from inline base64. */
  private async prepareAttachments(
    attachments: OutgoingAttachment[] | undefined,
  ): Promise<{ filename: string; content: Buffer; contentType?: string }[]> {
    if (!attachments?.length) return [];
    return Promise.all(
      attachments.map(async (attachment) => {
        if (attachment.content_base64) {
          return {
            filename: attachment.filename ?? "attachment",
            content: Buffer.from(attachment.content_base64, "base64"),
            contentType: attachment.content_type,
          };
        }
        if (!attachment.path) {
          throw new MailError(
            "Each attachment needs either `path` (a file on the machine running this server) " +
              "or `content_base64`.",
            "config",
          );
        }
        if (!this.config.allowLocalFiles) {
          throw new MailError(
            "This deployment cannot read local files: `path` would point at the server's own " +
              "disk, not yours. Send the file as `content_base64` instead.",
            "config",
          );
        }
        const full = resolvePath(attachment.path);
        const content = await readFile(full).catch(() => {
          throw new MailError(`Cannot read the attachment \`${full}\`.`, "config");
        });
        if (content.byteLength > this.config.maxAttachmentBytes) {
          throw new MailError(
            `\`${full}\` is ${content.byteLength} bytes, above MAIL_MAX_ATTACHMENT_BYTES ` +
              `(${this.config.maxAttachmentBytes}).`,
            "config",
          );
        }
        return {
          filename: attachment.filename ?? basename(full),
          content,
          contentType: attachment.content_type,
        };
      }),
    );
  }

  /**
   * Builds the RFC 822 message once and hands the same bytes to SMTP and to the
   * Sent folder, so the copy you keep is the message that was actually sent —
   * same Message-ID, same boundaries — rather than a re-composed lookalike.
   */
  async compose(options: SendOptions): Promise<{ raw: Buffer; to: Address[]; messageId: string }> {
    const to = parseAddressList(options.to);
    const cc = parseAddressList(options.cc);
    const bcc = parseAddressList(options.bcc);
    const everyone = [...to, ...cc, ...bcc];

    if (everyone.length === 0) {
      throw new MailError("No recipient given.", "config");
    }
    const invalid = everyone.filter((entry) => !isValidAddress(entry.address));
    if (invalid.length > 0) {
      throw new MailError(
        `Not an email address: ${invalid.map((entry) => entry.address).join(", ")}.`,
        "config",
      );
    }
    this.assertRecipientsAllowed(everyone);

    if (!options.text && !options.html) {
      throw new MailError("The message has no body: give `text`, `html`, or both.", "config");
    }

    // A Message-ID of our own, so the Sent copy and any later reply agree on it.
    const domain = this.config.fromAddress.split("@")[1] ?? "mail-mcp.local";
    const messageId = `<${randomUUID()}@${domain}>`;

    const composer = new MailComposer({
      from: { name: this.config.fromName ?? "", address: this.config.fromAddress },
      to: to.map(toNodemailer),
      cc: cc.length ? cc.map(toNodemailer) : undefined,
      bcc: bcc.length ? bcc.map(toNodemailer) : undefined,
      replyTo: options.replyTo || undefined,
      subject: options.subject,
      text: options.text,
      html: options.html,
      inReplyTo: options.inReplyTo,
      references: options.references?.length ? options.references.join(" ") : undefined,
      messageId,
      attachments: await this.prepareAttachments(options.attachments),
      headers: options.headers,
      // Never let a body reach out to the network or the disk while being built.
      disableFileAccess: true,
      disableUrlAccess: true,
    });

    const raw = await composer.compile().build();
    return { raw, to: everyone, messageId };
  }

  /** Hands a composed message to SMTP. */
  async send(raw: Buffer, recipients: Address[]): Promise<{ accepted: string[]; response: string }> {
    try {
      const info = await this.smtp().sendMail({
        raw,
        envelope: {
          from: this.config.fromAddress,
          to: recipients.map((entry) => entry.address),
        },
      });
      return {
        accepted: (info.accepted ?? []).map(String),
        response: info.response ?? "accepted",
      };
    } catch (error) {
      throw this.smtpError(error);
    }
  }

  private smtpError(error: unknown): MailError {
    const raw = error as { message?: string; code?: string; responseCode?: number };
    const message = raw?.message ?? String(error);
    const smtp = this.config.smtp;

    if (raw?.responseCode === 535 || /535|authentication failed|BadCredentials/i.test(message)) {
      return new MailError(
        `SMTP rejected the credentials for ${smtp?.user} on ${smtp?.host}. ` +
          (this.config.provider?.authNote ??
            "An app-specific password is usually required here, and it is often the same one the " +
              "IMAP side uses.") +
          `\n\nServer said: ${message}`,
        "smtp",
      );
    }
    if (raw?.responseCode === 550 || raw?.responseCode === 553) {
      return new MailError(
        `The server refused the message: ${message}. A From address the account is not allowed to ` +
          `send as is the usual cause — this deployment sends as ${this.config.fromAddress}.`,
        "smtp",
      );
    }
    if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|timed? out/i.test(message)) {
      return new MailError(
        `Cannot reach the SMTP server ${smtp?.host}:${smtp?.port} — ${message}. Submission is ` +
          "usually port 587 with STARTTLS or 465 with TLS; port 25 is blocked by most networks.",
        "smtp",
      );
    }
    return new MailError(message, "smtp");
  }

  /** Files a copy of a message in a folder, creating the folder if it is missing. */
  async appendMessage(raw: Buffer, folder: string, flags: string[] = ["\\Seen"]): Promise<string | undefined> {
    const path = await this.resolveOrCreateFolder(folder).catch(() => undefined);
    if (!path) return undefined;
    await this.run((client) => client.append(path, raw, flags, new Date()));
    return path;
  }

  /** Digest of the connection, for the diagnostics tool. */
  describe(): Record<string, unknown> {
    return {
      imap: `${this.config.imap.host}:${this.config.imap.port} (${this.config.imap.secure ? "TLS" : "STARTTLS"})`,
      smtp: this.config.smtp
        ? `${this.config.smtp.host}:${this.config.smtp.port} (${this.config.smtp.secure ? "TLS" : "STARTTLS"})`
        : "not configured — sending is unavailable",
      user: this.config.imap.user,
      from: this.config.fromName
        ? formatAddress({ name: this.config.fromName, address: this.config.fromAddress })
        : this.config.fromAddress,
      provider: this.config.provider?.label ?? "custom",
      default_folder: this.config.defaultFolder,
      read_only: this.config.readOnly,
      allowed_folders: this.config.allowedFolders.length ? this.config.allowedFolders : "all",
      allowed_recipients: this.config.allowedRecipients.length ? this.config.allowedRecipients : "any",
    };
  }
}

function toNodemailer(address: Address): { name: string; address: string } {
  return { name: address.name ?? "", address: address.address };
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

/** Short, stable identifier for a message, used where a UID is too fragile to quote. */
export function messageFingerprint(messageId: string | undefined, uid: number): string {
  return createHash("sha1").update(messageId ?? String(uid)).digest("hex").slice(0, 12);
}
