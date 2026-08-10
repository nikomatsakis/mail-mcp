import { z } from "zod";
import { defineTool, folderShape, json, uidSet, type ToolContext } from "./helpers.js";
import { buildCriteria, searchShape } from "./messages.js";

const uidsShape = {
  uids: z
    .array(z.number().int().min(1))
    .min(1)
    .max(500)
    .describe("Message UIDs to act on, from mail_list_messages or mail_search"),
};

/** Flags, moving, copying and deleting — everything that changes the mailbox. */
export function registerActionTools(ctx: ToolContext): void {
  const { client } = ctx;

  defineTool(
    ctx,
    "mail_set_flags",
    {
      ...folderShape,
      ...uidsShape,
      read: z.boolean().optional().describe("true marks as read, false marks as unread"),
      flagged: z.boolean().optional().describe("true stars the message, false unstars it"),
      answered: z.boolean().optional().describe("Set or clear the answered marker"),
      add_keywords: z
        .array(z.string())
        .optional()
        .describe("Custom keywords to add, e.g. [\"$Important\"] — support varies by server"),
      remove_keywords: z.array(z.string()).optional().describe("Custom keywords to remove"),
    },
    {
      title: "Mark messages",
      description:
        "Sets or clears the state a mail client shows: read/unread, flagged, answered, plus any " +
        "custom keywords the server accepts. Several messages at once, in one round trip.",
    },
    async (args) => {
      const add: string[] = [];
      const remove: string[] = [];
      const bucket = (value: boolean | undefined, flag: string) => {
        if (value === true) add.push(flag);
        if (value === false) remove.push(flag);
      };
      bucket(args.read, "\\Seen");
      bucket(args.flagged, "\\Flagged");
      bucket(args.answered, "\\Answered");
      add.push(...(args.add_keywords ?? []));
      remove.push(...(args.remove_keywords ?? []));

      if (add.length === 0 && remove.length === 0) {
        throw new Error(
          "Nothing to change. Set at least one of read, flagged, answered, add_keywords or remove_keywords.",
        );
      }

      return client.withFolder(args.folder ?? ctx.config.defaultFolder, async (imap, path) => {
        const range = uidSet(args.uids);
        if (add.length) await imap.messageFlagsAdd(range, add, { uid: true });
        if (remove.length) await imap.messageFlagsRemove(range, remove, { uid: true });
        return json({ folder: path, messages: args.uids.length, added: add, removed: remove });
      });
    },
  );

  defineTool(
    ctx,
    "mail_mark_search_read",
    {
      ...folderShape,
      ...searchShape,
      read: z.boolean().optional().describe("true marks matches read (default), false marks unread"),
      max_messages: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe("Safety ceiling on how many messages may be touched (default 500)"),
    },
    {
      title: "Mark everything matching a search",
      description:
        "Applies the read state to every message a search matches — \"mark all the newsletters " +
        "as read\" without listing them first. The same filters as mail_search, and a ceiling so " +
        "an over-broad query cannot quietly touch the whole mailbox.",
    },
    async (args) => {
      const ceiling = args.max_messages ?? 500;
      const criteria = buildCriteria(args);
      const markRead = args.read !== false;

      return client.withFolder(args.folder ?? ctx.config.defaultFolder, async (imap, path) => {
        const { uids, total } = await client.searchUids(imap, criteria, ceiling);
        if (uids.length === 0) return json({ folder: path, matched: 0, changed: 0 });
        const range = uidSet(uids);
        if (markRead) {
          await imap.messageFlagsAdd(range, ["\\Seen"], { uid: true });
        } else {
          await imap.messageFlagsRemove(range, ["\\Seen"], { uid: true });
        }
        return json({
          folder: path,
          matched: total,
          changed: uids.length,
          marked: markRead ? "read" : "unread",
          note:
            total > uids.length
              ? `${total - uids.length} older matches were left untouched by the ${ceiling}-message ceiling. Run again to continue.`
              : undefined,
        });
      });
    },
  );

  defineTool(
    ctx,
    "mail_move_messages",
    {
      ...folderShape,
      ...uidsShape,
      to_folder: z.string().describe("Destination folder path or alias (archive, trash, …)"),
    },
    {
      title: "Move messages",
      description:
        "Moves messages to another folder — filing mail, archiving it, or emptying the inbox. " +
        "UIDs belong to one folder, so the numbers change on arrival; the new ones are reported " +
        "back when the server supplies them.",
    },
    async (args) => {
      const destination = await client.resolveFolder(args.to_folder);
      return client.withFolder(args.folder ?? ctx.config.defaultFolder, async (imap, path) => {
        if (destination === path) throw new Error(`\`${path}\` is already the destination.`);
        const result = await imap.messageMove(uidSet(args.uids), destination, { uid: true });
        return json({
          moved: args.uids.length,
          from: path,
          to: destination,
          new_uids: result ? [...(result.uidMap?.values() ?? [])] : undefined,
        });
      });
    },
  );

  defineTool(
    ctx,
    "mail_copy_messages",
    {
      ...folderShape,
      ...uidsShape,
      to_folder: z.string().describe("Destination folder path or alias"),
    },
    {
      title: "Copy messages",
      description: "Copies messages into another folder, leaving the originals where they are.",
    },
    async (args) => {
      const destination = await client.resolveFolder(args.to_folder);
      return client.withFolder(args.folder ?? ctx.config.defaultFolder, async (imap, path) => {
        const result = await imap.messageCopy(uidSet(args.uids), destination, { uid: true });
        return json({
          copied: args.uids.length,
          from: path,
          to: destination,
          new_uids: result ? [...(result.uidMap?.values() ?? [])] : undefined,
        });
      });
    },
  );

  defineTool(
    ctx,
    "mail_delete_messages",
    {
      ...folderShape,
      ...uidsShape,
      permanent: z
        .boolean()
        .optional()
        .describe("Expunge immediately instead of moving to Trash — cannot be undone"),
      confirm: z.boolean().optional().describe("Required when `permanent` is true"),
    },
    {
      title: "Delete messages",
      description:
        "Moves messages to Trash, which is what deleting means in every mail client and leaves " +
        "them recoverable. `permanent: true` expunges them from the server instead, and then " +
        "`confirm: true` is required as well, because nothing brings them back.",
      destructive: true,
    },
    async (args) => {
      if (args.permanent && !args.confirm) {
        return json(
          `Refused: permanent deletion removes ${args.uids.length} message(s) from the server for ` +
            "good. Pass `confirm: true` to proceed, or drop `permanent` to move them to Trash.",
        );
      }

      const trash = args.permanent
        ? undefined
        : await client.resolveOrCreateFolder((await client.specialFolder("\\Trash")) ?? "Trash");

      return client.withFolder(args.folder ?? ctx.config.defaultFolder, async (imap, path) => {
        // Deleting out of Trash can only mean permanently.
        const alreadyInTrash = trash !== undefined && path === trash;
        if (args.permanent || alreadyInTrash) {
          if (alreadyInTrash && !args.permanent && !args.confirm) {
            return json(
              `\`${path}\` is the Trash folder, so there is nowhere further to move these messages. ` +
                "Pass `permanent: true` and `confirm: true` to erase them.",
            );
          }
          await imap.messageDelete(uidSet(args.uids), { uid: true });
          return json({ deleted: args.uids.length, folder: path, permanent: true });
        }

        await imap.messageMove(uidSet(args.uids), trash!, { uid: true });
        return json({
          deleted: args.uids.length,
          folder: path,
          moved_to: trash,
          permanent: false,
          note: "Moved to Trash — still recoverable from there.",
        });
      });
    },
  );
}
