/**
 * whats-proxy — Utility actions (4).
 *
 * connection-status, presence, read-messages, media-download.
 */

import { homedir } from "node:os";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import type { ActionDef, ActionContext } from "./types.ts";
import { requireApproval } from "../decorators.ts";
import { phoneToJid, okResult, errResult } from "../helpers.ts";
import { connectionStatusSchema, presenceSchema, readMessagesSchema, mediaDownloadSchema } from "./schemas.ts";

export default [
  {
    meta: {
      action: "connection-status",
      category: "utilities",
      description: "Check the WhatsApp connection status, account info, and store statistics. Works even when disconnected.",
      arguments: [],
      example: {},
      returns: "{ state, user, store_stats, reconnect_attempts }",
    },
    handler: async (_args, ctx: ActionContext) => {
      const info = ctx.connectionInfo();
      return okResult(info as unknown as Record<string, unknown>);
    },
    schema: connectionStatusSchema,
    docstring: `Check the WhatsApp connection status, account info, and store statistics.

Parameters: (none)

Examples:
    - \`whats-proxy do connection-status '{}'\`
    → {"state":"open","user":{"id":"33605957785@s.whatsapp.net","name":"KπX"},"store_stats":{"chats":85,"contacts":250,"messages":12500},"reconnect_attempts":0}`,
  },
  {
    meta: {
      action: "presence",
      category: "utilities",
      description: "Send a presence update or typing indicator. Types: available | unavailable | composing | recording | paused.",
      arguments: [
        { name: "type", description: "Presence type: available | unavailable | composing | recording | paused.", required: true },
        { name: "jid", description: "Chat JID for composing/recording/paused (required for typing indicators).", required: false },
      ],
      example: { type: "composing", jid: "237675836168" },
      returns: "{ status, jid }",
    },
    handler: requireApproval("default")(async ({ type, jid }, { sock }) => {
      if (type === "available" || type === "unavailable") {
        await sock.sendPresenceUpdate(type as any);
        return okResult({ status: type });
      }
      if (!jid) return errResult("JID is required for typing indicators (composing/recording/paused).");
      const chatJid = phoneToJid(String(jid));
      await sock.sendPresenceUpdate(type as any, chatJid);
      return okResult({ status: type, jid: chatJid });
    }),
    schema: presenceSchema,
    docstring: `Send a presence update or typing indicator.

Parameters:
    - type (required): available | unavailable | composing | recording | paused.
    - jid (optional): Chat JID for typing indicators.

Examples:
    - \`whats-proxy do presence '{"type":"available"}'\`
    → {"status":"available"}
    - \`whats-proxy do presence '{"type":"composing","jid":"237675836168"}'\`
    → {"status":"composing","jid":"237675836168@s.whatsapp.net"}`,
  },
  {
    meta: {
      action: "read-messages",
      category: "utilities",
      description: "Mark specific messages as read (send read receipts).",
      arguments: [
        { name: "jid", description: "Chat JID.", required: true },
        { name: "message_ids", description: "Array of message IDs to mark as read.", required: true },
        { name: "participant", description: "Sender JID (required for group messages).", required: false },
      ],
      example: { jid: "237675836168", message_ids: ["ABC123"] },
      returns: "{ status, jid, count }",
    },
    handler: requireApproval("default")(async ({ jid, message_ids, participant }, { sock }) => {
      const chatJid = phoneToJid(String(jid));
      const ids = Array.isArray(message_ids) ? message_ids.map(String) : [];
      const keys = ids.map((id) => ({
        remoteJid: chatJid,
        id,
        ...(participant ? { participant: String(participant) } : {}),
      }));
      await sock.readMessages(keys);
      return okResult({ status: "read", jid: chatJid, count: ids.length });
    }),
    schema: readMessagesSchema,
    docstring: `Mark specific messages as read (send read receipts).

Parameters:
    - jid (required): Chat JID.
    - message_ids (required): Array of message IDs to mark as read.
    - participant (optional): Sender JID (required for group messages).

Examples:
    - \`whats-proxy do read-messages '{"jid":"237675836168","message_ids":["ABC123"]}'\`
    → {"status":"read","jid":"237675836168@s.whatsapp.net","count":1}
    - \`whats-proxy do read-messages '{"jid":"120363421516672794","message_ids":["MSG001","MSG002","MSG003"]}'\`
    → {"status":"read","jid":"120363421516672794@g.us","count":3}`,
  },
  {
    meta: {
      action: "media-download",
      category: "utilities",
      description: "Download media (image, video, audio, document, sticker) from one or more messages to ~/Downloads/.",
      arguments: [
        { name: "message_ids", description: "Message ID or array of message IDs containing media.", required: true },
      ],
      example: { message_ids: ["ABC123"] },
      returns: "{ results }",
    },
    handler: async ({ message_ids }, { sock, store }) => {
      const ids = Array.isArray(message_ids)
        ? message_ids.map(String)
        : [String(message_ids)];

      if (ids.length === 0) return errResult("'message_ids' must be a non-empty string or array.");

      const downloadsDir = join(homedir(), "Downloads");
      if (!existsSync(downloadsDir)) mkdirSync(downloadsDir, { recursive: true });

      const results: any[] = [];

      for (const messageId of ids) {
        const msg = store.getMessage(messageId);
        if (!msg) {
          results.push({ message_id: messageId, error: "Message not found in store." });
          continue;
        }

        const m = msg.message;
        if (!m) {
          results.push({ message_id: messageId, error: "Message has no content." });
          continue;
        }

        let mediaMsg: any = null;
        let mediaType: string | null = null;
        const mediaTypes: [string, string][] = [
          ["imageMessage", "image"],
          ["videoMessage", "video"],
          ["audioMessage", "audio"],
          ["documentMessage", "document"],
          ["stickerMessage", "sticker"],
          ["documentWithCaptionMessage", "document"],
        ];

        for (const [key, type] of mediaTypes) {
          if (m[key]) { mediaMsg = m[key]; mediaType = type; break; }
        }
        if (m.documentWithCaptionMessage?.message?.documentMessage) {
          mediaMsg = m.documentWithCaptionMessage.message.documentMessage;
          mediaType = "document";
        }
        if (!mediaMsg) {
          results.push({ message_id: messageId, error: "Message does not contain downloadable media." });
          continue;
        }

        let buffer: Buffer;
        try {
          buffer = (await downloadMediaMessage(msg as any, "buffer", {})) as Buffer;
        } catch (err) {
          results.push({ message_id: messageId, error: `Download failed: ${(err as Error).message}` });
          continue;
        }

        let fileName = mediaMsg.fileName || mediaMsg.title || `${messageId}.${mediaType}`;
        fileName = String(fileName).replace(/[^a-zA-Z0-9.\-_]/g, "_");
        let ext = extname(fileName);
        if (!ext && mediaMsg.mimetype) {
          const mimeExt = String(mediaMsg.mimetype).split("/")[1]?.split(";")[0];
          if (mimeExt) fileName += `.${mimeExt}`;
        }

        const filePath = join(downloadsDir, fileName);
        writeFileSync(filePath, buffer);

        results.push({
          message_id: messageId,
          media_type: mediaType,
          mimetype: mediaMsg.mimetype || null,
          filename: fileName,
          file_length: buffer.length,
          saved_to: filePath,
        });
      }

      return okResult({ results });
    },
    schema: mediaDownloadSchema,
    docstring: `Download media (image, video, audio, document, sticker) from one or more messages to ~/Downloads/.

Parameters:
    - message_ids (required): Message ID (string) or array of message IDs.

Examples:
    - Download one image:
        \`whats-proxy do media-download '{"message_ids":"IMG001"}'\`
    - Download multiple:
        \`whats-proxy do media-download '{"message_ids":["IMG001","DOC001","VID001"]}'\`
    → {"results":[{"message_id":"IMG001","media_type":"image","saved_to":"/home/kpihx/Downloads/IMG001.jpg",...},...]}`,
  },
] satisfies ActionDef[];
