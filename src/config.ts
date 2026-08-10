import { findProvider, providerForAddress, type Provider } from "./providers.js";

/**
 * Configuration comes from the environment in stdio mode and from request headers
 * in HTTP mode, so the same server works as a local process and as a hosted
 * endpoint that carries no accounts of its own.
 *
 * A mailbox needs two connections that are configured separately almost
 * everywhere — IMAP for reading, SMTP for sending — so both are resolved here,
 * with the SMTP side falling back to the IMAP credentials, which is what nearly
 * every provider expects.
 */

export interface ImapConfig {
  host: string;
  port: number;
  /** true = implicit TLS; false = plain socket upgraded via STARTTLS when offered. */
  secure: boolean;
  user: string;
  pass: string;
  /** oauth2 sends the value of `pass` as an XOAUTH2 access token instead of a password. */
  oauth2: boolean;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  oauth2: boolean;
}

export interface Config {
  imap: ImapConfig;
  smtp?: SmtpConfig;
  /** Address put in the From header. Defaults to the IMAP user when it looks like an address. */
  fromAddress: string;
  /** Display name for the From header, optional. */
  fromName?: string;
  /** Preset the hosts came from, for diagnostics and better error messages. */
  provider?: Provider;
  /** Folder used when a tool omits one. */
  defaultFolder: string;
  /**
   * When non-empty, the only folders any tool may touch. The default folder and
   * the special-use folders needed for sending are not exempt: an allowlist that
   * omits them simply makes those operations unavailable.
   */
  allowedFolders: string[];
  /**
   * When non-empty, mail may only be addressed to these recipients. An entry is
   * either a full address or a domain suffix written as `@example.com`.
   */
  allowedRecipients: string[];
  /** Read-only mode: refuse every tool that would send, move, flag or delete. */
  readOnly: boolean;
  /** Copy every sent message into the Sent folder over IMAP. */
  appendToSent: boolean;
  /** Reject untrusted TLS certificates. Self-signed internal servers need this off. */
  rejectUnauthorized: boolean;
  timeoutMs: number;
  /** Hard cap for how much of an attachment we are willing to inline. */
  maxAttachmentBytes: number;
  /** Message bodies longer than this are truncated before reaching the model. */
  maxBodyChars: number;
  /**
   * Whether attachments may be read from the local filesystem. True for a local
   * process, false for a hosted deployment, where "the local filesystem" would be
   * the server's own disk rather than the caller's.
   */
  allowLocalFiles: boolean;
}

/** The raw values a caller supplies, before validation and normalisation. */
export interface RawConfig {
  provider?: string;
  user?: string;
  password?: string;
  authType?: string;
  imapHost?: string;
  imapPort?: string;
  imapSecure?: string;
  imapUser?: string;
  imapPassword?: string;
  smtpHost?: string;
  smtpPort?: string;
  smtpSecure?: string;
  smtpUser?: string;
  smtpPassword?: string;
  from?: string;
  fromName?: string;
  defaultFolder?: string;
  allowedFolders?: string;
  allowedRecipients?: string;
  readOnly?: string;
  appendToSent?: string;
  rejectUnauthorized?: string;
  timeoutMs?: string;
  maxAttachmentBytes?: string;
  maxBodyChars?: string;
  allowLocalFiles?: string;
}

export class ConfigError extends Error {}

function isTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function isFalse(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "false";
}

function toNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Comma or whitespace separated list, trimmed and emptied of blanks. */
function toList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Ports imply their transport: 993 and 465 are TLS from the first byte, 143 and
 * 587 start in the clear and upgrade with STARTTLS. An explicit setting always wins.
 */
function resolveSecure(explicit: string | undefined, port: number, fallback: boolean): boolean {
  if (isTrue(explicit)) return true;
  if (isFalse(explicit)) return false;
  if (port === 993 || port === 465) return true;
  if (port === 143 || port === 587 || port === 25 || port === 1025 || port === 1143) return false;
  return fallback;
}

function stripPort(host: string): string {
  // A host pasted as `imap.example.com:993` is a common slip; keep the name only.
  return host.trim().replace(/^\w+:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
}

export function resolveConfig(raw: RawConfig): Config {
  const user = (raw.imapUser ?? raw.user)?.trim();
  const password = raw.imapPassword ?? raw.password;

  if (!user) {
    throw new ConfigError(
      "No mailbox user supplied. Set the address you log in with, for example alice@example.com.",
    );
  }
  if (!password) {
    throw new ConfigError(
      "No mailbox password supplied. Most providers refuse the account password over IMAP and " +
        "want an app-specific password instead.",
    );
  }

  // An explicitly named preset wins; otherwise the address domain may still identify one.
  const named = raw.provider?.trim() ? findProvider(raw.provider) : undefined;
  if (raw.provider?.trim() && !named) {
    throw new ConfigError(
      `Unknown mail provider \`${raw.provider.trim()}\`. Give the IMAP and SMTP hosts directly, ` +
        "or use one of: gmail, outlook, yahoo, icloud, fastmail, zoho, yandex, mailru, gmx, aol, " +
        "migadu, mailbox, proton.",
    );
  }
  const provider = named ?? providerForAddress(raw.from?.trim() || user);

  const imapHost = raw.imapHost?.trim() ? stripPort(raw.imapHost) : provider?.imapHost;
  if (!imapHost) {
    throw new ConfigError(
      "No IMAP host supplied and the address does not match a known provider. " +
        "Set the IMAP server name (your provider's help pages call it 'incoming mail server'), " +
        "or name a provider preset.",
    );
  }

  const imapPort = toNumber(raw.imapPort, provider?.imapPort ?? 993);
  const oauth2 = raw.authType?.trim().toLowerCase() === "oauth2";

  const imap: ImapConfig = {
    host: imapHost,
    port: imapPort,
    secure: resolveSecure(raw.imapSecure, imapPort, provider?.imapSecure ?? true),
    user,
    pass: password,
    oauth2,
  };

  // Sending is optional: a read-only mailbox needs no SMTP host at all.
  const smtpHost = raw.smtpHost?.trim() ? stripPort(raw.smtpHost) : provider?.smtpHost;
  const smtpPort = toNumber(raw.smtpPort, provider?.smtpPort ?? 587);
  const smtp: SmtpConfig | undefined = smtpHost
    ? {
        host: smtpHost,
        port: smtpPort,
        secure: resolveSecure(raw.smtpSecure, smtpPort, provider?.smtpSecure ?? false),
        user: raw.smtpUser?.trim() || user,
        pass: raw.smtpPassword ?? password,
        oauth2,
      }
    : undefined;

  const fromAddress = raw.from?.trim() || (user.includes("@") ? user : "");
  if (smtp && !fromAddress) {
    throw new ConfigError(
      `The login name \`${user}\` is not an email address, so the From header cannot be derived ` +
        "from it. Set the address messages should be sent from.",
    );
  }

  return {
    imap,
    smtp,
    fromAddress,
    fromName: raw.fromName?.trim() || undefined,
    provider,
    defaultFolder: raw.defaultFolder?.trim() || "INBOX",
    allowedFolders: toList(raw.allowedFolders),
    allowedRecipients: toList(raw.allowedRecipients).map((entry) => entry.toLowerCase()),
    readOnly: isTrue(raw.readOnly),
    appendToSent: !isFalse(raw.appendToSent),
    rejectUnauthorized: !isFalse(raw.rejectUnauthorized),
    timeoutMs: toNumber(raw.timeoutMs, 60_000),
    maxAttachmentBytes: toNumber(raw.maxAttachmentBytes, 8 * 1024 * 1024),
    maxBodyChars: toNumber(raw.maxBodyChars, 40_000),
    allowLocalFiles: !isFalse(raw.allowLocalFiles),
  };
}

/** Configuration for stdio mode, read from the process environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  try {
    return resolveConfig({
      provider: env.MAIL_PROVIDER,
      user: env.MAIL_USER ?? env.MAIL_ADDRESS,
      password: env.MAIL_PASSWORD ?? env.MAIL_PASS,
      authType: env.MAIL_AUTH_TYPE,
      imapHost: env.IMAP_HOST ?? env.MAIL_IMAP_HOST,
      imapPort: env.IMAP_PORT ?? env.MAIL_IMAP_PORT,
      imapSecure: env.IMAP_SECURE ?? env.MAIL_IMAP_SECURE,
      imapUser: env.IMAP_USER,
      imapPassword: env.IMAP_PASSWORD,
      smtpHost: env.SMTP_HOST ?? env.MAIL_SMTP_HOST,
      smtpPort: env.SMTP_PORT ?? env.MAIL_SMTP_PORT,
      smtpSecure: env.SMTP_SECURE ?? env.MAIL_SMTP_SECURE,
      smtpUser: env.SMTP_USER,
      smtpPassword: env.SMTP_PASSWORD,
      from: env.MAIL_FROM,
      fromName: env.MAIL_FROM_NAME,
      defaultFolder: env.MAIL_DEFAULT_FOLDER,
      allowedFolders: env.MAIL_ALLOWED_FOLDERS,
      allowedRecipients: env.MAIL_ALLOWED_RECIPIENTS,
      readOnly: env.MAIL_READ_ONLY,
      appendToSent: env.MAIL_APPEND_TO_SENT,
      rejectUnauthorized: env.MAIL_TLS_REJECT_UNAUTHORIZED,
      timeoutMs: env.MAIL_TIMEOUT_MS,
      maxAttachmentBytes: env.MAIL_MAX_ATTACHMENT_BYTES,
      maxBodyChars: env.MAIL_MAX_BODY_CHARS,
      allowLocalFiles: env.MAIL_ALLOW_LOCAL_FILES,
    });
  } catch (error) {
    if (error instanceof ConfigError && /No mailbox user/.test(error.message)) {
      throw new ConfigError(`MAIL_USER is not set. ${error.message}`);
    }
    if (error instanceof ConfigError && /No mailbox password/.test(error.message)) {
      throw new ConfigError(`MAIL_PASSWORD is not set. ${error.message}`);
    }
    if (error instanceof ConfigError && /No IMAP host/.test(error.message)) {
      throw new ConfigError(`IMAP_HOST is not set. ${error.message}`);
    }
    throw error;
  }
}

/** Stable identity of a mailbox connection, used to key the connection pool. */
export function connectionKey(config: Config): string {
  const { host, port, user, pass, secure } = config.imap;
  // The password is part of the identity — a changed password must not reuse a
  // connection authenticated with the old one — but it is never logged.
  let hash = 0;
  for (let index = 0; index < pass.length; index++) {
    hash = (hash * 31 + pass.charCodeAt(index)) | 0;
  }
  return `${host}:${port}:${secure ? "tls" : "plain"}:${user}:${hash}`;
}
