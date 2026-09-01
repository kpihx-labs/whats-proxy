/**
 * whats-proxy — Story actions (3).
 *
 * story-list, story-download, story-view.
 *
 * story-post, story-reply, story-delete removed (v0.6.1): WhatsApp does not
 * propagate status updates posted from linked/companion devices (Baileys).
 * sendMessage to status@broadcast returns success locally but WhatsApp servers
 * silently drop the post. story-reply is just a regular DM (not a story reply).
 * story-delete fails because the revoke is not propagated to the server.
 * See Baileys issues #2084, #2118, #1582, #682 for confirmation.
 *
 * "Story" is WhatsApp's ephemeral 24-hour broadcast (the UI label), distinct
 * from the persistent "About" status text (handled by `profile-about`).
 * Stories arrive in the local store under remoteJid `status@broadcast` with
 * `key.participant` = the author.
 */

import type { ActionDef } from "./types.ts";
import { phoneToJid, resolveMedia, okResult, errResult, formatMessage, STATUS_BROADCAST } from "../helpers.ts";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  storyListSchema, storyDownloadSchema, storyViewSchema,
} from "./schemas.ts";
import type { AnyMsg } from "../store.ts";

/** Map a story (status@broadcast) message to a readable row with resolved author. */
function _storyRow(msg: AnyMsg, store: { resolveContactName(jid: string): string | null }, meId?: string) {
  const f = formatMessage(msg);
  const author = msg?.key?.participant || (msg?.key?.fromMe && meId ? meId : msg?.key?.remoteJid) || "";
  return {
    id: msg?.key?.id || null,
    author: author,
    author_name: store.resolveContactName(author),
    type: f?.type || "unknown",
    text: f?.text || "",
    timestamp: f?.timestamp ?? null,
  };
}

export default [
  {
    meta: {
      action: "story-list",
      category: "stories",
      description:
        "List stories (24-hour status updates) captured in the local store, newest first. Stories are grouped by author; each row carries the author JID, resolved name, content type, text, and timestamp.",
      arguments: [
        { name: "jid", description: "Optional: filter to stories from this author JID.", required: false },
        { name: "limit", description: "Max stories to return (default 50, max 200).", required: false },
      ],
      example: { limit: 50 },
      returns: "{ total, stories }",
    },
    handler: async ({ jid, limit }, { sock, store }) => {
      const lim = Math.min(Number(limit) || 50, 200);
      const meId = (sock as any).user?.id as string | undefined;
      let msgs = store.getMessages(STATUS_BROADCAST, lim);
      if (jid) {
        const target = phoneToJid(String(jid));
        msgs = msgs.filter((m: AnyMsg) => (m?.key?.participant || m?.key?.remoteJid) === target);
      }
      const stories = msgs.map((m: AnyMsg) => _storyRow(m, store, meId));
      return okResult({ total: stories.length, stories });
    },
    schema: storyListSchema,
    docstring: `List stories (24-hour status updates) captured in the local store.

Parameters:
    - jid (optional): Filter to stories from this author JID.
    - limit (optional): Max stories to return (default 50, max 200).

Examples:
    - List all stories:
        \`whats-proxy do story-list '{}'\`
        → {"total":3,"stories":[{"id":"A56036DC...","author":"238908008874169@lid","author_name":"Alice","type":"image","text":"[image]","timestamp":1756614000}]}
    - List stories from one author:
        \`whats-proxy do story-list '{"jid":"238908008874169@lid"}'\`
        → {"total":1,"stories":[{"id":"A56036DC...","author":"238908008874169@lid","author_name":"Alice","type":"image","text":"[image]"}]}`,
  },
  {
    meta: {
      action: "story-download",
      category: "stories",
      description:
        "Download media (image/video/audio) from a story. The story must be in the local store. Returns the local file path where the media was saved.",
      arguments: [
        { name: "message_id", description: "Story message ID containing media.", required: true },
      ],
      example: { message_id: "A56036DC..." },
      returns: "{ message_id, media_type, mimetype, filename, file_length, saved_to }",
    },
    handler: async ({ message_id }, { store }) => {
      const msg = store.getMessage(String(message_id));
      if (!msg) return errResult(`Story ${message_id} not found in store.`);
      const m = msg.message || {};
      const mediaTypes: [string, string][] = [
        ["imageMessage", "image"],
        ["videoMessage", "video"],
        ["audioMessage", "audio"],
      ];
      let mediaMsg: any = null;
      let mediaType: string | null = null;
      for (const [key, type] of mediaTypes) {
        if (m[key]) { mediaMsg = m[key]; mediaType = type; break; }
      }
      if (!mediaMsg) return errResult("Story does not contain downloadable media.");
      let buffer: Buffer;
      try {
        buffer = (await downloadMediaMessage(msg as never, "buffer", {})) as Buffer;
      } catch (err) {
        return errResult(`Failed to download story media: ${(err as Error).message}`);
      }
      const cacheDir = join(homedir(), ".cache", "whats_media");
      if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
      const mimeExtMap: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "audio/ogg": "ogg", "audio/mpeg": "mp3" };
      const defaultExt = mediaMsg.mimetype ? (mimeExtMap[String(mediaMsg.mimetype)] || String(mediaMsg.mimetype).split("/")[1]?.split(";")[0] || "bin") : (mediaType || "bin");
      let fileName = mediaMsg.fileName || `${message_id}.${defaultExt}`;
      fileName = String(fileName).replace(/[^a-zA-Z0-9.\-_]/g, "_");
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
    schema: storyDownloadSchema,
    docstring: `Download media (image/video/audio) from a story.

Parameters:
    - message_id (required): Story message ID containing media.

Examples:
    - Download an image story:
        \`whats-proxy do story-download '{"message_id":"A56036DC..."}'\`
        → {"message_id":"A56036DC...","media_type":"image","mimetype":"image/jpeg","filename":"A56036DC.jpg","file_length":123456,"saved_to":"/home/user/.cache/whats_media/A56036DC.jpg"}
    - Download a video story:
        \`whats-proxy do story-download '{"message_id":"B67147ED..."}'\`
        → {"message_id":"B67147ED...","media_type":"video","mimetype":"video/mp4","filename":"B67147ED.mp4","file_length":2048000,"saved_to":"/home/user/.cache/whats_media/B67147ED.mp4"}
    - Download a story not in store (error):
        \`whats-proxy do story-download '{"message_id":"NONEXISTENT"}'\`
        → {"meta":{"status":"error","comment":"Story NONEXISTENT not found in store.","edited":false},"data":{"error":"Story NONEXISTENT not found in store."}}`,
  },
  {
    meta: {
      action: "story-view",
      category: "stories",
      description:
        "View a single story's full content: author, resolved name, type, text, and media preview. Marks the story as read in the local store.",
      arguments: [
        { name: "message_id", description: "Story message ID to view.", required: true },
      ],
      example: { message_id: "A56036DC..." },
      returns: "{ id, author, author_name, type, text, timestamp }",
    },
    handler: async ({ message_id }, { sock, store }) => {
      const msg = store.getMessage(String(message_id));
      if (!msg) return errResult(`Story ${message_id} not found in store.`);
      return okResult(_storyRow(msg, store, (sock as any).user?.id as string | undefined));
    },
    schema: storyViewSchema,
    docstring: `View a single story's full content.

Parameters:
    - message_id (required): Story message ID to view.

Examples:
    - View an image story:
        \`whats-proxy do story-view '{"message_id":"A56036DC..."}'\`
        → {"id":"A56036DC...","author":"238908008874169@lid","author_name":"Alice","type":"image","text":"[image]","timestamp":1756614000}
    - View a text story:
        \`whats-proxy do story-view '{"message_id":"C78258FE..."}'\`
        → {"id":"C78258FE...","author":"156263862272061@lid","author_name":"Bob","type":"text","text":"Hello everyone","timestamp":1756614100}
    - View a story not in store (error):
        \`whats-proxy do story-view '{"message_id":"NONEXISTENT"}'\`
        → {"meta":{"status":"error","comment":"Story NONEXISTENT not found in store.","edited":false},"data":{"error":"Story NONEXISTENT not found in store."}}`,
  },
] satisfies ActionDef[];
