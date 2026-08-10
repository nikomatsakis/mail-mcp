import iconv from "iconv-lite";
import type { MessageAddressObject } from "imapflow";

/**
 * The parts of MIME a mail client cannot avoid: text that arrives in whatever
 * charset the sender's machine used twenty years ago, HTML that has to become
 * readable prose, and addresses that must survive a round trip through a header.
 */

/** Decodes a body part into a string, honouring the charset the server declared. */
export function decodeText(bytes: Buffer, charset?: string): string {
  const encoding = (charset ?? "utf-8").trim().toLowerCase();
  if (!encoding || encoding === "utf-8" || encoding === "utf8" || encoding === "us-ascii") {
    return bytes.toString("utf8");
  }
  // Russian, Japanese and legacy Western mail still arrives in koi8-r, cp1251,
  // iso-2022-jp and friends, none of which Buffer knows how to decode.
  if (iconv.encodingExists(encoding)) {
    try {
      return iconv.decode(bytes, encoding);
    } catch {
      return bytes.toString("utf8");
    }
  }
  return bytes.toString("utf8");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  deg: "°",
  times: "×",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1]?.toLowerCase() === "x"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * Turns an HTML body into something worth reading. Marketing mail is mostly
 * layout tables, so the goal is prose and links, not a faithful rendering:
 * invisible content is dropped, block elements become line breaks, and a link
 * whose text does not already contain the target keeps its URL in brackets.
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|noscript)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    // `li` is absent on purpose: the opening tag already starts the line, and
    // closing it too would put a blank line between every pair of bullets.
    .replace(/<\/(p|div|tr|h[1-6]|table|blockquote|section|article)>/gi, "\n")
    .replace(/<(hr)\s*\/?>/gi, "\n---\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<td[^>]*>/gi, "\t");

  // Keep the destination of a link when the visible text does not reveal it.
  text = text.replace(
    /<a\b[^>]*href\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, label: string) => {
      const visible = label.replace(/<[^>]+>/g, "").trim();
      if (!href || href.startsWith("mailto:") || href.startsWith("#")) return visible;
      if (!visible) return href;
      return visible.includes(href) || href.includes(visible) ? visible : `${visible} (${href})`;
    },
  );

  text = decodeEntities(text.replace(/<[^>]+>/g, ""));

  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Undoes the soft line breaks of format=flowed, so paragraphs read as paragraphs. */
export function unflow(text: string, delSp = false): string {
  return text
    .split(/\r?\n/)
    .reduce<string[]>((lines, line) => {
      const previous = lines[lines.length - 1];
      if (previous !== undefined && previous.endsWith(" ")) {
        lines[lines.length - 1] = (delSp ? previous.slice(0, -1) : previous) + line;
        return lines;
      }
      lines.push(line);
      return lines;
    }, [])
    .join("\n");
}

export interface Address {
  name?: string;
  address: string;
}

/** `Name <a@b.c>` when there is a name, the bare address otherwise. */
export function formatAddress(address: MessageAddressObject | Address | undefined): string {
  if (!address?.address) return address?.name ?? "";
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

export function formatAddresses(list: MessageAddressObject[] | undefined): string[] {
  return (list ?? []).map(formatAddress).filter(Boolean);
}

/**
 * Parses the address forms a person or a model will actually type: a bare
 * address, `Name <addr>`, `"Last, First" <addr>`, and any of those separated by
 * commas or semicolons.
 */
export function parseAddressList(input: string | string[] | undefined): Address[] {
  if (!input) return [];
  const raw = Array.isArray(input) ? input.join(",") : input;
  const entries: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;

  for (const char of raw) {
    if (char === '"') inQuotes = !inQuotes;
    if (char === "<") inAngle = true;
    if (char === ">") inAngle = false;
    if ((char === "," || char === ";") && !inQuotes && !inAngle) {
      entries.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  entries.push(current);

  return entries
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const angle = /^(.*?)<([^>]+)>$/.exec(entry);
      if (angle) {
        const name = angle[1].trim().replace(/^"(.*)"$/, "$1").trim();
        return { name: name || undefined, address: angle[2].trim() };
      }
      return { address: entry };
    });
}

const ADDRESS_PATTERN = /^[^\s@,<>"]+@[^\s@,<>".]+\.[^\s@,<>"]+$/;

export function isValidAddress(address: string): boolean {
  return ADDRESS_PATTERN.test(address.trim());
}

/** Truncates long bodies, saying so, rather than flooding the conversation. */
export function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: `${text.slice(0, limit)}\n\n[… truncated: ${text.length - limit} more characters. Raise MAIL_MAX_BODY_CHARS or read the message in parts.]`,
    truncated: true,
  };
}

/** `> ` prefixes for a reply body, in the shape every mail client produces. */
export function quote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.startsWith(">") ? `>${line}` : `> ${line}`))
    .join("\n");
}

/** IMAP flags as plain words, since `\Seen` means nothing outside the protocol. */
export function describeFlags(flags: Set<string> | undefined): string[] {
  if (!flags) return [];
  const names: Record<string, string> = {
    "\\Seen": "read",
    "\\Answered": "answered",
    "\\Flagged": "flagged",
    "\\Deleted": "deleted",
    "\\Draft": "draft",
    "\\Recent": "recent",
  };
  return [...flags].map((flag) => names[flag] ?? flag);
}

/** The subject with every layer of Re:/Fwd:/Aw:/Ответ: stripped off. */
export function baseSubject(subject: string | undefined): string {
  let value = (subject ?? "").trim();
  let previous = "";
  while (value !== previous) {
    previous = value;
    value = value.replace(/^(re|fw|fwd|aw|sv|vs|antw|ответ|пересылка)\s*(\[\d+\])?\s*:\s*/i, "").trim();
  }
  return value;
}

export function replySubject(subject: string | undefined): string {
  const base = baseSubject(subject);
  return base ? `Re: ${base}` : "Re:";
}

export function forwardSubject(subject: string | undefined): string {
  const base = baseSubject(subject);
  return base ? `Fwd: ${base}` : "Fwd:";
}

/** Splits a References header into individual message ids. */
export function parseReferences(value: string | undefined): string[] {
  if (!value) return [];
  return value.match(/<[^>]+>/g) ?? [];
}
