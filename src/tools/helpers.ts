import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import type { Config } from "../config.js";
import { MailError, type MailClient } from "../mail-client.js";

export interface ToolContext {
  server: McpServer;
  client: MailClient;
  config: Config;
  /** Every tool name passed to defineTool, whether or not it was registered. */
  knownTools: Set<string>;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; blob?: string; text?: string } };

export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
  [key: string]: unknown;
}

export function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

/** JSON results are pretty-printed so the model can read them without re-parsing. */
export function json(value: unknown, note?: string): ToolResult {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text(note ? `${note}\n\n${body}` : body);
}

export function blocks(content: ContentBlock[]): ToolResult {
  return { content };
}

/** The folder argument, shared by every tool that touches messages. */
export const folderShape = {
  folder: z
    .string()
    .optional()
    .describe(
      "Folder to work in. Accepts a real path (`INBOX`, `INBOX/Clients`) or an alias resolved " +
        "through the server's own special-use flags: inbox, sent, drafts, trash, junk, archive. " +
        "Defaults to MAIL_DEFAULT_FOLDER.",
    ),
};

/** Paging shared by the listing tools. */
export const pagingShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("How many messages to return, newest first (default 25, max 200)"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Skip this many matches before returning any — for paging through a large result"),
};

/** The UID argument. UIDs are stable within a folder; sequence numbers are not. */
export const uidShape = {
  uid: z
    .number()
    .int()
    .min(1)
    .describe("Message UID, as returned by mail_list_messages or mail_search"),
};

/** Drop undefined keys so an omitted argument never becomes an explicit null. */
export function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/** A UID list as an IMAP sequence set: `4`, `4,7,9`, or a range the caller gave. */
export function uidSet(uids: number[] | number): string {
  return Array.isArray(uids) ? uids.join(",") : String(uids);
}

interface DefineOptions {
  title: string;
  description: string;
  /** false marks the tool as mutating; it is then blocked in read-only mode. */
  readOnly?: boolean;
  destructive?: boolean;
}

/**
 * Registers a tool with uniform error handling and the read-only guard, so
 * individual handlers stay focused on the mailbox itself.
 */
export function defineTool<S extends ZodRawShape>(
  ctx: ToolContext,
  name: string,
  schema: S,
  options: DefineOptions,
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<ToolResult>,
): void {
  ctx.knownTools.add(name);
  const { allowedTools } = ctx.config;
  if (allowedTools && !allowedTools.includes(name)) return;

  ctx.server.registerTool(
    name,
    {
      title: options.title,
      description: options.description,
      inputSchema: schema,
      annotations: {
        title: options.title,
        readOnlyHint: options.readOnly ?? false,
        destructiveHint: options.destructive ?? false,
      },
    },
    (async (args: z.objectOutputType<S, z.ZodTypeAny>) => {
      try {
        if (ctx.config.readOnly && !options.readOnly) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Refused: \`${name}\` changes the mailbox and the server runs with ` +
                  "MAIL_READ_ONLY=true.",
              },
            ],
            isError: true,
          };
        }
        return await handler(args);
      } catch (error) {
        const message =
          error instanceof MailError
            ? error.message
            : ((error as Error).message ?? String(error));
        return {
          content: [{ type: "text" as const, text: `Error in ${name}: ${message}` }],
          isError: true,
        };
      }
    }) as never,
  );
}
