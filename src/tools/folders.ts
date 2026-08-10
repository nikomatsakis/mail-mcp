import { z } from "zod";
import { defineTool, folderShape, json, type ToolContext } from "./helpers.js";

/** Mailbox structure: what folders exist, how full they are, and managing them. */
export function registerFolderTools(ctx: ToolContext): void {
  const { client } = ctx;

  defineTool(
    ctx,
    "mail_list_folders",
    {
      with_counts: z
        .boolean()
        .optional()
        .describe("Include message and unread counts per folder — one extra round trip each"),
      subscribed_only: z.boolean().optional().describe("Only folders the account subscribes to"),
    },
    {
      title: "List folders",
      description:
        "Every folder in the account, with its special-use role where the server declares one " +
        "(inbox, sent, drafts, trash, junk, archive). Use this to learn the real names before " +
        "moving mail around: providers localise them and Gmail nests them under [Gmail].",
      readOnly: true,
    },
    async (args) => {
      const folders = await client.listFolders(true);
      const visible = folders.filter((folder) => !args.subscribed_only || folder.subscribed);

      const counts = args.with_counts
        ? await client.withClient(async (imap) => {
            const result = new Map<string, { messages?: number; unseen?: number }>();
            for (const folder of visible) {
              // \Noselect folders are containers only; STATUS on them errors.
              if (folder.flags.has("\\Noselect")) continue;
              try {
                const status = await imap.status(folder.path, { messages: true, unseen: true });
                result.set(folder.path, { messages: status.messages, unseen: status.unseen });
              } catch {
                // A folder that refuses STATUS still belongs in the listing.
              }
            }
            return result;
          })
        : undefined;

      return json({
        count: visible.length,
        folders: visible.map((folder) => ({
          path: folder.path,
          name: folder.name,
          special_use: folder.specialUse?.replace(/^\\/, "").toLowerCase(),
          subscribed: folder.subscribed,
          selectable: !folder.flags.has("\\Noselect"),
          messages: counts?.get(folder.path)?.messages,
          unread: counts?.get(folder.path)?.unseen,
        })),
      });
    },
  );

  defineTool(
    ctx,
    "mail_folder_status",
    { ...folderShape },
    {
      title: "Folder status",
      description:
        "Message count, unread count and the next UID for one folder — the cheap way to ask " +
        "\"is there anything new?\" without listing messages.",
      readOnly: true,
    },
    async (args) => {
      const path = await client.resolveFolder(args.folder);
      const status = await client.withClient((imap) =>
        imap.status(path, { messages: true, unseen: true, recent: true, uidNext: true }),
      );
      return json({
        folder: path,
        messages: status.messages,
        unread: status.unseen,
        recent: status.recent,
        next_uid: status.uidNext,
      });
    },
  );

  defineTool(
    ctx,
    "mail_folder_action",
    {
      action: z
        .enum(["create", "rename", "delete", "subscribe", "unsubscribe"])
        .describe("What to do with the folder"),
      folder: z.string().describe("Folder path to act on, e.g. `INBOX/Clients`"),
      new_name: z.string().optional().describe("New full path — for `rename` only"),
      confirm: z
        .boolean()
        .optional()
        .describe("Required for `delete`: deleting a folder discards every message in it"),
    },
    {
      title: "Create, rename or delete a folder",
      description:
        "Manages the folder tree. Deleting is irreversible on most servers and therefore needs " +
        "`confirm: true`. New subfolders are written with the delimiter the server reports, so " +
        "`INBOX/Clients` lands correctly whether the server separates with `/` or `.`.",
      destructive: true,
    },
    async (args) => {
      const folders = await client.listFolders();
      const delimiter = folders[0]?.delimiter ?? "/";
      // A path typed with `/` must still work on a server that separates with `.`.
      const normalise = (path: string) => path.trim().split(/[/.]/).filter(Boolean).join(delimiter);

      switch (args.action) {
        case "create": {
          const path = normalise(args.folder);
          client.assertFolderAllowed(path);
          const result = await client.withClient((imap) => imap.mailboxCreate(path));
          client.clearFolderCache();
          return json({
            created: result.created,
            folder: result.path,
            note: result.created ? undefined : "A folder with that path already existed.",
          });
        }
        case "rename": {
          if (!args.new_name) throw new Error("`new_name` is required for a rename.");
          const from = await client.resolveFolder(args.folder);
          const to = normalise(args.new_name);
          client.assertFolderAllowed(to);
          const result = await client.withClient((imap) => imap.mailboxRename(from, to));
          client.clearFolderCache();
          return json({ renamed: result.path, to: result.newPath });
        }
        case "delete": {
          const path = await client.resolveFolder(args.folder);
          if (!args.confirm) {
            return json(
              `Refused: deleting \`${path}\` removes the folder and every message in it, and most ` +
                "servers cannot undo that. Pass `confirm: true` to proceed.",
            );
          }
          if (path.toUpperCase() === "INBOX") {
            throw new Error("INBOX cannot be deleted.");
          }
          await client.withClient((imap) => imap.mailboxDelete(path));
          client.clearFolderCache();
          return json({ deleted: path });
        }
        case "subscribe":
        case "unsubscribe": {
          const path = await client.resolveFolder(args.folder);
          const subscribed = args.action === "subscribe";
          await client.withClient((imap) =>
            subscribed ? imap.mailboxSubscribe(path) : imap.mailboxUnsubscribe(path),
          );
          client.clearFolderCache();
          return json({ folder: path, subscribed });
        }
      }
    },
  );
}
