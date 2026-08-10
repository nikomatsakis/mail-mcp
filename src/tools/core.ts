import { z } from "zod";
import { defineTool, json, type ToolContext } from "./helpers.js";

/** Diagnostics: is the mailbox reachable, and under what restrictions. */
export function registerCoreTools(ctx: ToolContext): void {
  const { client } = ctx;

  defineTool(
    ctx,
    "mail_whoami",
    {
      check_smtp: z
        .boolean()
        .optional()
        .describe("Also log in to the outgoing server to prove sending works (default true)"),
    },
    {
      title: "Mailbox & connection check",
      description:
        "Verifies the IMAP login and, unless disabled, the SMTP login, then reports the account, " +
        "both servers, the folder count, unread mail in the inbox and the quota. Run this first " +
        "when anything is unclear: it separates a wrong password from a wrong host from a " +
        "restriction this server applies on purpose.",
      readOnly: true,
    },
    async (args) => {
      const folders = await client.listFolders(true);
      const quota = await client.withClient((imap) => imap.getQuota().catch(() => false));
      const capabilities = await client.withClient(async (imap) => [...imap.capabilities.keys()].sort());
      const status = await client.withClient((imap) =>
        imap.status("INBOX", { messages: true, unseen: true }).catch(() => undefined),
      );

      let smtpLogin = "not checked";
      if (args.check_smtp !== false) {
        if (!ctx.config.smtp) {
          smtpLogin = "not configured — sending is unavailable";
        } else {
          smtpLogin = await client
            .verifySmtp()
            .then(() => "ok")
            .catch((error: Error) => `failed — ${error.message}`);
        }
      }

      return json({
        ...client.describe(),
        imap_login: "ok",
        smtp_login: smtpLogin,
        folders: folders.length,
        inbox: status ? { messages: status.messages, unread: status.unseen } : undefined,
        quota:
          quota && typeof quota === "object" && quota.storage
            ? {
                used_bytes: quota.storage.used,
                limit_bytes: quota.storage.limit,
                used_percent:
                  quota.storage.limit > 0
                    ? Math.round((quota.storage.used / quota.storage.limit) * 100)
                    : undefined,
              }
            : "not reported by this server",
        server_capabilities: capabilities,
      });
    },
  );
}
