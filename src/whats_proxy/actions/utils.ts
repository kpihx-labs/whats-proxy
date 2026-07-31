/**
 * whats-proxy — Utility actions (7).
 *
 * connection-status, guide, presence, read-messages, search-messages,
 * media-download, media-cleanup.
 *
 * Faithful port of whats-mcp `utils.js`.
 */

import { homedir } from "node:os";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { join, extname } from "node:path";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import type { ActionDef, ActionContext } from "./types.ts";
import { phoneToJid, okResult, errResult } from "../helpers.ts";
import { VERSION } from "../version.ts";

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
  },
  {
    meta: {
      action: "guide",
      category: "utilities",
      description: "Get a comprehensive guide on how to use whats-proxy actions. Optionally filter by category.",
      arguments: [
        { name: "category", description: "Category: overview | messaging | chats | contacts | groups | profile | channels | labels | analytics | utilities.", required: false },
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
            "Batch: Use batch-send-text to send the same message to multiple recipients.",
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
    handler: async ({ type, jid }, { sock }) => {
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
    },
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
    handler: async ({ jid, message_ids, participant }, { sock }) => {
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
    },
  },
  {
    meta: {
      action: "search-messages",
      category: "utilities",
      description:
        "Search messages in the local store by text content. Filter by one or multiple chat JIDs, time range, and message types. Only searches messages already in memory.",
      arguments: [
        { name: "query", description: "Text to search for (case-insensitive).", required: true },
        { name: "jid", description: "Optional: limit search to this chat JID or phone number.", required: false },
        { name: "jids", description: "Optional: search across multiple chat JIDs. Takes precedence over jid.", required: false },
        { name: "limit", description: "Max results (default 50, max 200).", required: false },
        { name: "since", description: "Unix timestamp: only include messages sent at or after this time.", required: false },
        { name: "until", description: "Unix timestamp: only include messages sent at or before this time.", required: false },
        { name: "include_types", description: "If set, only include messages of these types.", required: false },
        { name: "exclude_types", description: "Exclude messages of these types.", required: false },
      ],
      example: { query: "stage" },
      returns: "{ query, count, messages }",
    },
    handler: async ({ query, jid, jids, limit, since, until, include_types, exclude_types }, { store }) => {
      let chatJids: string | string[] | null = null;
      if (Array.isArray(jids) && jids.length > 0) {
        chatJids = jids.map((j) => phoneToJid(String(j)));
      } else if (jid) {
        chatJids = phoneToJid(String(jid));
      }
      const lim = Math.min(Number(limit) || 50, 200);
      const results = store.searchMessages(String(query), chatJids, lim, {
        since: since !== undefined ? Number(since) : undefined,
        until: until !== undefined ? Number(until) : undefined,
        types: Array.isArray(include_types) ? include_types.map(String) : undefined,
        excludeTypes: Array.isArray(exclude_types) ? exclude_types.map(String) : undefined,
      });
      return okResult({
        query,
        count: results.length,
        messages: results,
      });
    },
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
    handler: async ({ message_id }, { sock, store }) => {
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
    },
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
    handler: async () => {
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
    },
  },
] satisfies ActionDef[];
