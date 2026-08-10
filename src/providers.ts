/**
 * Host presets for the mail services people actually use.
 *
 * Nobody remembers that Fastmail's IMAP host is `imap.fastmail.com` and its SMTP
 * port is 465 while iCloud wants 587 with STARTTLS. Naming the provider — or just
 * giving an address ending in a domain listed below — fills all of it in, so the
 * only configuration left is the address and the password.
 */

export interface Provider {
  /** Human-readable name used in messages and in the docs. */
  label: string;
  imapHost: string;
  imapPort: number;
  /** true = implicit TLS on connect; false = plain connection upgraded with STARTTLS. */
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  /** Address domains that map to this preset, for auto-detection. */
  domains: string[];
  /** Shown when authentication fails, because the reason is nearly always the same one. */
  authNote?: string;
}

export const PROVIDERS: Record<string, Provider> = {
  gmail: {
    label: "Gmail / Google Workspace",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    smtpSecure: true,
    domains: ["gmail.com", "googlemail.com"],
    authNote:
      "Gmail refuses account passwords over IMAP. Turn on 2-Step Verification, then create an " +
      "App password (myaccount.google.com/apppasswords) and use that 16-character value. " +
      "Workspace accounts additionally need IMAP enabled by the administrator.",
  },
  outlook: {
    label: "Outlook.com / Microsoft 365",
    imapHost: "outlook.office365.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    smtpSecure: false,
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com", "office365.com"],
    authNote:
      "Microsoft has switched personal accounts and most tenants to OAuth only, so a password " +
      "usually fails here. Supply an OAuth2 access token as MAIL_PASSWORD together with " +
      "MAIL_AUTH_TYPE=oauth2, or use an account that still permits basic authentication.",
  },
  yahoo: {
    label: "Yahoo Mail",
    imapHost: "imap.mail.yahoo.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.mail.yahoo.com",
    smtpPort: 465,
    smtpSecure: true,
    domains: ["yahoo.com", "yahoo.co.uk", "ymail.com", "rocketmail.com"],
    authNote: "Yahoo requires an app password, created under Account security → App passwords.",
  },
  icloud: {
    label: "iCloud Mail",
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    smtpSecure: false,
    domains: ["icloud.com", "me.com", "mac.com"],
    authNote:
      "iCloud requires an app-specific password from appleid.apple.com, and the user name is " +
      "usually the part of your address before @, not the full address.",
  },
  fastmail: {
    label: "Fastmail",
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.fastmail.com",
    smtpPort: 465,
    smtpSecure: true,
    domains: ["fastmail.com", "fastmail.fm", "messagingengine.com"],
    authNote: "Fastmail requires an app password created under Settings → Privacy & Security.",
  },
  zoho: {
    label: "Zoho Mail",
    imapHost: "imap.zoho.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.zoho.com",
    smtpPort: 465,
    smtpSecure: true,
    domains: ["zoho.com", "zohomail.com"],
    authNote:
      "Zoho requires an application-specific password and IMAP access enabled in Mail Settings. " +
      "Accounts in the EU or India data centres use zoho.eu / zoho.in instead.",
  },
  yandex: {
    label: "Yandex Mail",
    imapHost: "imap.yandex.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.yandex.com",
    smtpPort: 465,
    smtpSecure: true,
    domains: ["yandex.ru", "yandex.com", "ya.ru", "yandex.by", "yandex.kz"],
    authNote:
      "Yandex requires an application password and IMAP switched on under " +
      "Settings → Mail clients.",
  },
  mailru: {
    label: "Mail.ru",
    imapHost: "imap.mail.ru",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.mail.ru",
    smtpPort: 465,
    smtpSecure: true,
    domains: ["mail.ru", "inbox.ru", "bk.ru", "list.ru", "internet.ru"],
    authNote: "Mail.ru requires an application password created in the security settings.",
  },
  gmx: {
    label: "GMX",
    imapHost: "imap.gmx.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "mail.gmx.com",
    smtpPort: 465,
    smtpSecure: true,
    domains: ["gmx.com", "gmx.net", "gmx.de", "gmx.at", "gmx.ch"],
    authNote: "GMX needs IMAP/POP access enabled in the web interface before any client can log in.",
  },
  aol: {
    label: "AOL Mail",
    imapHost: "imap.aol.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.aol.com",
    smtpPort: 465,
    smtpSecure: true,
    domains: ["aol.com"],
    authNote: "AOL requires an app password from the account security page.",
  },
  migadu: {
    label: "Migadu",
    imapHost: "imap.migadu.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.migadu.com",
    smtpPort: 465,
    smtpSecure: true,
    domains: ["migadu.com"],
  },
  mailbox: {
    label: "mailbox.org",
    imapHost: "imap.mailbox.org",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.mailbox.org",
    smtpPort: 465,
    smtpSecure: true,
    domains: ["mailbox.org"],
  },
  proton: {
    label: "Proton Mail (via Proton Bridge)",
    imapHost: "127.0.0.1",
    imapPort: 1143,
    imapSecure: false,
    smtpHost: "127.0.0.1",
    smtpPort: 1025,
    smtpSecure: false,
    domains: ["proton.me", "protonmail.com", "pm.me"],
    authNote:
      "Proton has no public IMAP. Install Proton Bridge, which exposes the mailbox on localhost, " +
      "and use the user name and password the Bridge shows you — not your Proton account password. " +
      "Because the Bridge listens on 127.0.0.1, this preset only works for a locally run server.",
  },
};

/** Case-insensitive preset lookup, with a couple of aliases people reach for. */
export function findProvider(name: string): Provider | undefined {
  const key = name.trim().toLowerCase().replace(/[\s._-]/g, "");
  const aliases: Record<string, string> = {
    google: "gmail",
    googlemail: "gmail",
    gsuite: "gmail",
    googleworkspace: "gmail",
    hotmail: "outlook",
    live: "outlook",
    office365: "outlook",
    microsoft: "outlook",
    o365: "outlook",
    me: "icloud",
    apple: "icloud",
    protonmail: "proton",
    mailboxorg: "mailbox",
    "mail.ru": "mailru",
  };
  return PROVIDERS[aliases[key] ?? key];
}

/** Preset for an address, so `alice@fastmail.com` alone configures both hosts. */
export function providerForAddress(address: string): Provider | undefined {
  const domain = address.trim().toLowerCase().split("@")[1];
  if (!domain) return undefined;
  return Object.values(PROVIDERS).find((provider) => provider.domains.includes(domain));
}
