import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { MailClient } from "./mail-client.js";
import { registerActionTools } from "./tools/actions.js";
import { registerAttachmentTools } from "./tools/attachments.js";
import { registerComposeTools } from "./tools/compose.js";
import { registerFolderTools } from "./tools/folders.js";
import type { ToolContext } from "./tools/helpers.js";
import { registerMessageTools } from "./tools/messages.js";
import { registerCoreTools } from "./tools/core.js";

export const SERVER_NAME = "mail-mcp";
export const SERVER_VERSION = "1.0.0";

/**
 * Builds a fully configured MCP server. Called once in stdio mode and once per
 * request in HTTP mode, where each caller brings their own mailbox. The IMAP
 * connection itself is pooled behind the client, so a per-request server does
 * not mean a per-request login.
 */
export function buildServer(config: Config): { server: McpServer; client: MailClient } {
  const client = new MailClient(config);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        `Email over IMAP and SMTP for ${config.imap.user}.\n` +
        "Messages are addressed by UID within a folder — a UID is only meaningful together with " +
        "the folder it came from, and changes when a message is moved.\n" +
        "Folders accept aliases (inbox, sent, drafts, trash, junk, archive) that resolve to " +
        "whatever this account actually calls them.\n" +
        "mail_list_messages and mail_search return summaries; mail_read_message returns the body " +
        "and the attachment list; mail_read_attachment returns an attachment, images included.\n" +
        "Read a message before replying to it — mail_reply builds the threading headers from the " +
        "original.\n" +
        (config.readOnly ? "This server is read-only: nothing can be sent or changed.\n" : "") +
        (config.allowedRecipients.length
          ? `Outgoing mail is restricted to ${config.allowedRecipients.join(", ")}.\n`
          : "") +
        (config.allowedFolders.length
          ? `Only these folders are reachable: ${config.allowedFolders.join(", ")}.\n`
          : ""),
    },
  );

  const ctx: ToolContext = { server, client, config };
  registerCoreTools(ctx);
  registerFolderTools(ctx);
  registerMessageTools(ctx);
  registerAttachmentTools(ctx);
  registerComposeTools(ctx);
  registerActionTools(ctx);

  return { server, client };
}
