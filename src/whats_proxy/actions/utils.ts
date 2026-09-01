/**
 * whats-proxy — Utility actions (6).
 *
 * connection-status, guide, presence, read-messages,
 * media-download, media-cleanup.
 *
 * Faithful port of whats-mcp `utils.js`.
 */

import { homedir } from "node:os";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { join, extname } from "node:path";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import type { ActionDef, ActionContext } from "./types.ts";
import { requireApproval } from "../decorators.ts";
import { phoneToJid, okResult, errResult } from "../helpers.ts";
import { VERSION } from "../version.ts";
import {
  connectionStatusSchema, guideSchema, presenceSchema, readMessagesSchema,
  mediaDownloadSchema, mediaCleanupSchema,
} from "./schemas.ts";

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

Parameters:
    (none)

Examples:
    - Check connection status:
        \`whats-proxy do connection-status '{}'\`
        → {"state":"open","user":{"id":"33612345678@s.whatsapp.net","name":"Ivann"},"store_stats":{"chats":85,"contacts":250,"messages":12500},"reconnect_attempts":0}
    - Status when disconnected:
        \`whats-proxy do connection-status '{}'\`
        → {"state":"close","user":null,"store_stats":{"chats":85,"contacts":250,"messages":12500},"reconnect_attempts":3}
    - Status during connecting:
        \`whats-proxy do connection-status '{}'\`
        → {"state":"connecting","user":null,"store_stats":{"chats":85,"contacts":250,"messages":12500},"reconnect_attempts":1}`,
  },
  {
    meta: {
      action: "guide",
      category: "utilities",
      description: "Get a comprehensive guide on how to use whats-proxy actions. Optionally filter by category.",
      arguments: [
        { name: "category", description: "Category: overview | messaging | chats | contacts | groups | profile | channels | stories | analytics | utilities.", required: false },
      ],
      example: { category: "messaging" },
      returns: "{ server, version, total_tools, categories, tips } | { category, tools }",
    },
    handler: async ({ category }, ctx: ActionContext) => {
      const cat = String(category || "overview");
      const toolDefs = Object.values(ctx.registry || {}).map((d) => ({
        name: d.meta.action,
        category: d.meta.category,
        description: d.meta.description,
        inputSchema: {
          type: "object",
          properties: Object.fromEntries(
            d.meta.arguments.map((a) => [a.name, { type: "string", description: a.description }]),
          ),
          required: d.meta.arguments.filter((a) => a.required).map((a) => a.name),
        },
      }));

      if (cat === "overview") {
        const categories: Record<string, string[]> = {};
        for (const t of toolDefs) {
          const c = t.category;
          if (!categories[c]) categories[c] = [];
          categories[c].push(t.name);
        }
        return okResult({
          server: "whats-proxy",
          version: ctx.config?.server?.version || VERSION,
          total_tools: toolDefs.length,
          categories,
          tips: [
            "JIDs: Use phone numbers (e.g. 33612345678) or full JIDs (33612345678@s.whatsapp.net).",
            "Groups: Group JIDs end with @g.us (e.g. 120363xxx@g.us).",
            "Channels: Newsletter JIDs end with @newsletter.",
            "Media: Send images/videos/documents via URL, base64, or local file path.",
            "Batch: Use send-batch to send multiple content types to one or more recipients.",
            "Reactions: Use send-reaction with an emoji to react, empty string to remove.",
            "Reply: Use quoted_id parameter in send-* actions to reply to a specific message.",
          ],
        });
      }

      const catTools = toolDefs.filter((t) => t.category === cat);
      return okResult({
        category: cat,
        tools: catTools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema.properties ? Object.keys(t.inputSchema.properties) : [],
          required: t.inputSchema.required || [],
        })),
      });
    },
    schema: guideSchema,
    docstring: `Get a comprehensive guide on how to use whats-proxy actions.

Parameters:
    - category (optional): Category: overview | messaging | chats | contacts | groups | profile | stories | analytics | utilities.

Examples:
    - Get full guide:
        \`whats-proxy do guide '{}'\`
        → {"server":"whats-proxy","version":"0.6.0","total_tools":65,"categories":{"messaging":["send-text","send-image","send-video","send-audio","send-document","send-sticker","send-location","send-contact","send-reaction","send-poll","edit-message","delete-message","forward-message","send-batch"],"chats":["chat-list","chat-read","chat-manage","chat-star","chat-disappearing"]},"tips":["JIDs: Use phone numbers or full JIDs.","Groups: Group JIDs end with @g.us."]}
    - Get messaging category guide:
        \`whats-proxy do guide '{"category":"messaging"}'\`
        → {"category":"messaging","tools":[{"name":"send-text","description":"Send a text message to a contact or group.","parameters":["jid","text","quoted_id","mentions"],"required":["jid","text"]}]}
    - Get utilities guide:
        \`whats-proxy do guide '{"category":"utilities"}'\`
        → {"category":"utilities","tools":[{"name":"connection-status","description":"Check the WhatsApp connection status.","parameters":[],"required":[]}]}`,
  },
  {
    meta: {
      action: "presence",
      category: "utilities",
      description:
        "Send a presence update or typing indicator. Presence: 'available' (online), 'unavailable' (offline). Typing: 'composing' (typing), 'recording' (recording audio), 'paused' (stopped typing).",
      arguments: [
        { name: "type", description: "Presence type: available | unavailable | composing | recording | paused.", required: true },
        { name: "jid", description: "Chat JID for composing/recording/paused (required for typing indicators).", required: false },
      ],
      example: { type: "composing", jid: "33612345678" },
      returns: "{ status, jid }",
    },
    handler: requireApproval("default")(async ({ type, jid }, { sock }) => {
      if (type === "available" || type === "unavailable") {
        await sock.sendPresenceUpdate(type as any);
        return okResult({ status: type });
      }
      if (!jid) {
        return errResult("JID is required for typing indicators (composing/recording/paused).");
      }
      const chatJid = phoneToJid(String(jid));
      await sock.sendPresenceUpdate(type as any, chatJid);
      return okResult({ status: type, jid: chatJid });
    }),
    schema: presenceSchema,
    docstring: `Send a presence update or typing indicator.

Parameters:
    - type (required): Presence type: available | unavailable | composing | recording | paused.
    - jid (optional): Chat JID for composing/recording/paused (required for typing indicators).

Examples:
    - Show as online:
        \`whats-proxy do presence '{"type":"available"}'\`
        → {"status":"available"}
    - Show typing indicator:
        \`whats-proxy do presence '{"type":"composing","jid":"33612345678"}'\`
        → {"status":"composing","jid":"33612345678@s.whatsapp.net"}
    - Show recording indicator in a group:
        \`whats-proxy do presence '{"type":"recording","jid":"120363000000000@g.us"}'\`
        → {"status":"recording","jid":"120363000000000@g.us"}`,
  },
  {
    meta: {
      action: "read-messages",
      category: "utilities",
      description:
        "Mark specific messages as read (send read receipts). Provide the chat JID and message IDs to mark as read.",
      arguments: [
        { name: "jid", description: "Chat JID.", required: true },
        { name: "message_ids", description: "Array of message IDs to mark as read.", required: true },
        { name: "participant", description: "Sender JID (required for group messages to send proper receipts).", required: false },
      ],
      example: { jid: "33612345678", message_ids: ["ABC123"] },
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
      return okResult({
        status: "read",
        jid: chatJid,
        count: ids.length,
      });
    }),
    schema: readMessagesSchema,
    docstring: `Mark specific messages as read (send read receipts).

Parameters:
    - jid (required): Chat JID.
    - message_ids (required): Array of message IDs to mark as read.
    - participant (optional): Sender JID (required for group messages to send proper receipts).

Examples:
    - Mark one message as read:
        \`whats-proxy do read-messages '{"jid":"33612345678","message_ids":["ABC123"]}'\`
        → {"status":"read","jid":"33612345678@s.whatsapp.net","count":1}
    - Mark multiple messages as read:
        \`whats-proxy do read-messages '{"jid":"120363000000000@g.us","message_ids":["MSG001","MSG002","MSG003"]}'\`
        → {"status":"read","jid":"120363000000000@g.us","count":3}
    - Mark group message as read with participant:
        \`whats-proxy do read-messages '{"jid":"120363000000000@g.us","message_ids":["MSG004"],"participant":"33612345678@s.whatsapp.net"}'\`
        → {"status":"read","jid":"120363000000000@g.us","count":1}`,
  },
  {
    meta: {
      action: "media-download",
      category: "utilities",
      description:
        "Download media (image, video, audio, document, sticker) from a message. Returns the local file path where the media was saved ($HOME/.cache/whats_media/). The message must be in the local store.",
      arguments: [
        { name: "message_id", description: "Message ID containing media.", required: true },
      ],
      example: { message_id: "ABC123" },
      returns: "{ message_id, media_type, mimetype, filename, file_length, saved_to }",
    },
    handler: requireApproval("default")(async ({ message_id }, { sock, store }) => {
      const msg = store.getMessage(String(message_id));
      if (!msg) {
        return errResult(`Message ${message_id} not found in store.`);
      }

      const m = msg.message;
      if (!m) return errResult("Message has no content.");

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
        if (m[key]) {
          mediaMsg = m[key];
          mediaType = type;
          break;
        }
      }

      if (m.documentWithCaptionMessage?.message?.documentMessage) {
        mediaMsg = m.documentWithCaptionMessage.message.documentMessage;
        mediaType = "document";
      }

      if (!mediaMsg) {
        return errResult("Message does not contain downloadable media.");
      }

      let buffer: Buffer;
      try {
        buffer = (await downloadMediaMessage(msg as any, "buffer", {})) as Buffer;
      } catch (err) {
        return errResult(`Failed to download media: ${(err as Error).message}`);
      }

      const cacheDir = join(homedir(), ".cache", "whats_media");
      if (!existsSync(cacheDir)) {
        mkdirSync(cacheDir, { recursive: true });
      }

      let fileName = mediaMsg.fileName || mediaMsg.title || `${message_id}.${mediaType}`;
      fileName = String(fileName).replace(/[^a-zA-Z0-9.\-_]/g, "_");

      let ext = extname(fileName);
      if (!ext && mediaMsg.mimetype) {
        const mimeExt = String(mediaMsg.mimetype).split("/")[1]?.split(";")[0];
        if (mimeExt) fileName += `.${mimeExt}`;
      }

      const filePath = join(cacheDir, fileName);
      writeFileSync(filePath, buffer);

      return okResult({
        message_id,
        media_type: mediaType,
        mimetype: mediaMsg.mimetype || null,
        filename: fileName,
        file_length: buffer.length,
        saved_to: filePath,
      });
    }),
    schema: mediaDownloadSchema,
    docstring: `Download media (image, video, audio, document, sticker) from a message.

Parameters:
    - message_id (required): Message ID containing media.

Examples:
    - Download an image:
        \`whats-proxy do media-download '{"message_id":"IMG001"}'\`
        → {"message_id":"IMG001","media_type":"image","mimetype":"image/jpeg","filename":"IMG001.jpg","file_length":125000,"saved_to":"/home/kpihx/.cache/whats_media/IMG001.jpg"}
    - Download a document:
        \`whats-proxy do media-download '{"message_id":"DOC001"}'\`
        → {"message_id":"DOC001","media_type":"document","mimetype":"application/pdf","filename":"report.pdf","file_length":2500000,"saved_to":"/home/kpihx/.cache/whats_media/report.pdf"}
    - Download a video:
        \`whats-proxy do media-download '{"message_id":"VID001"}'\`
        → {"message_id":"VID001","media_type":"video","mimetype":"video/mp4","filename":"VID001.mp4","file_length":15000000,"saved_to":"/home/kpihx/.cache/whats_media/VID001.mp4"}`,
  },
  {
    meta: {
      action: "media-cleanup",
      category: "utilities",
      description: "Clear the local WhatsApp media cache directory ($HOME/.cache/whats_media/).",
      arguments: [],
      example: {},
      returns: "{ status, files_deleted, bytes_freed, cache_dir }",
    },
    handler: requireApproval("default")(async () => {
      const cacheDir = join(homedir(), ".cache", "whats_media");
      if (!existsSync(cacheDir)) {
        return okResult({ status: "skipped", message: "Cache directory does not exist." });
      }

      let count = 0;
      let bytesFreed = 0;
      const files = readdirSync(cacheDir);
      for (const file of files) {
        const filePath = join(cacheDir, file);
        const stats = statSync(filePath);
        if (stats.isFile()) {
          bytesFreed += stats.size;
          unlinkSync(filePath);
          count++;
        }
      }

      return okResult({
        status: "cleaned",
        files_deleted: count,
        bytes_freed: bytesFreed,
        cache_dir: cacheDir,
      });
    }),
    schema: mediaCleanupSchema,
    docstring: `Clear the local WhatsApp media cache directory.

Parameters:
    (none)

Examples:
    - Clean up media cache:
        \`whats-proxy do media-cleanup '{}'\`
        → {"status":"cleaned","files_deleted":12,"bytes_freed":156250000,"cache_dir":"/home/kpihx/.cache/whats_media"}
    - Empty cache directory:
        \`whats-proxy do media-cleanup '{}'\`
        → {"status":"cleaned","files_deleted":0,"bytes_freed":0,"cache_dir":"/home/kpihx/.cache/whats_media"}
    - Cache directory doesn't exist:
        \`whats-proxy do media-cleanup '{}'\`
        → {"status":"skipped","message":"Cache directory does not exist."}`,
  },
] satisfies ActionDef[];
