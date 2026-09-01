/**
 * whats-proxy — Story actions (6).
 *
 * story-list, story-post, story-download, story-view, story-reply, story-delete.
 *
 * "Story" is WhatsApp's ephemeral 24-hour broadcast (the UI label), distinct
 * from the persistent "About" status text (handled by `profile-about`).
 * Stories arrive in the local store under remoteJid `status@broadcast` with
 * `key.participant` = the author. Posting targets the same broadcast JID.
 */

import type { ActionDef } from "./types.ts";
import { requireApproval } from "../decorators.ts";
import { phoneToJid, resolveMedia, okResult, errResult, formatMessage, STATUS_BROADCAST } from "../helpers.ts";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";
import {
  storyListSchema, storyPostSchema, storyDownloadSchema, storyViewSchema, storyReplySchema, storyDeleteSchema,
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
      action: "story-post",
      category: "stories",
      description:
        "Post a story (24-hour status update). type: text | image | video | audio. For text, pass 'text'; for media, pass 'source' (URL/base64/path). Optional 'status_jid_list' restricts which JIDs can view the story (default: your status privacy).",
      arguments: [
        { name: "type", description: "Story type: text | image | video | audio. Default text.", required: false },
        { name: "text", description: "Text content (required for type=text).", required: false },
        { name: "source", description: "Media source: URL, base64, or local path (required for image/video/audio).", required: false },
        { name: "caption", description: "Caption for media stories.", required: false },
        { name: "status_jid_list", description: "Optional array of JIDs allowed to view the story.", required: false },
      ],
      example: { type: "text", text: "Hello world!" },
      returns: "{ status, message_id, type }",
    },
    handler: requireApproval("default")(async ({ type, text, source, caption, status_jid_list }, { sock }) => {
      const t = String(type || "text");
      const opts: Record<string, unknown> = {};
      if (Array.isArray(status_jid_list) && status_jid_list.length > 0) {
        opts.statusJidList = status_jid_list.map(String);
      }
      let content: Record<string, unknown>;
      if (t === "text") {
        if (!text) return errResult("text is required for type=text story.");
        content = { text: String(text) };
      } else if (t === "image") {
        if (!source) return errResult("source is required for image story.");
        content = { image: resolveMedia(String(source)) as never, ...(caption ? { caption: String(caption) } : {}) };
      } else if (t === "video") {
        if (!source) return errResult("source is required for video story.");
        content = { video: resolveMedia(String(source)) as never, ...(caption ? { caption: String(caption) } : {}) };
      } else if (t === "audio") {
        if (!source) return errResult("source is required for audio story.");
        content = { audio: resolveMedia(String(source)) as never };
      } else {
        return errResult(`Unknown story type: ${t}. Use text, image, video, or audio.`);
      }
      const result = await sock.sendMessage(STATUS_BROADCAST, content as never, opts as never);
      return okResult({
        status: "posted",
        message_id: result?.key?.id || null,
        type: t,
        ...(Array.isArray(status_jid_list) ? { audience: status_jid_list } : {}),
      });
    }),
    schema: storyPostSchema,
    docstring: `Post a story (24-hour status update) to your status.

Parameters:
    - type (optional): text | image | video | audio (default text).
    - text (optional): Text content (required for type=text).
    - source (optional): Media source URL/base64/path (required for media types).
    - caption (optional): Caption for media stories.
    - status_jid_list (optional): Array of JIDs allowed to view the story.

Examples:
    - Post a text story:
        \`whats-proxy do story-post '{"type":"text","text":"Hello world!"}'\`
        → {"status":"posted","message_id":"ABC123","type":"text"}
    - Post an image story:
        \`whats-proxy do story-post '{"type":"image","source":"/tmp/pic.jpg","caption":"Sunset"}'\`
        → {"status":"posted","message_id":"DEF456","type":"image"}
    - Post a text story visible only to two contacts:
        \`whats-proxy do story-post '{"type":"text","text":"Private","status_jid_list":["33612345678","33600000000"]}'\`
        → {"status":"posted","message_id":"GHI789","type":"text","audience":["33612345678","33600000000"]}`,
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
      // Derive extension from mimetype, not mediaType (avoids .image, .video, .audio).
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
  {
    meta: {
      action: "story-reply",
      category: "stories",
      description:
        "Reply to a story: sends a private message to the story author. The story must be in the local store.",
      arguments: [
        { name: "message_id", description: "Story message ID to reply to.", required: true },
        { name: "text", description: "Reply text.", required: true },
      ],
      example: { message_id: "A56036DC...", text: "Nice!" },
      returns: "{ status, to, message_id }",
    },
    handler: requireApproval("default")(async ({ message_id, text }, { sock, store }) => {
      const msg = store.getMessage(String(message_id));
      if (!msg) return errResult(`Story ${message_id} not found in store.`);
      const meId = (sock as any).user?.id as string | undefined;
      const author = msg?.key?.participant || (msg?.key?.fromMe && meId ? meId : msg?.key?.remoteJid);
      if (!author || author === STATUS_BROADCAST) return errResult("Story author not found.");
      const result = await sock.sendMessage(author, { text: String(text) } as never);
      return okResult({ status: "sent", to: author, message_id: result?.key?.id || null });
    }),
    schema: storyReplySchema,
    docstring: `Reply to a story: sends a private message to the story author.

Parameters:
    - message_id (required): Story message ID to reply to.
    - text (required): Reply text.

Examples:
    - Reply to a story:
        \`whats-proxy do story-reply '{"message_id":"A56036DC...","text":"Nice!"}'\`
        → {"status":"sent","to":"238908008874169@lid","message_id":"JKL012"}
    - Reply with a longer message:
        \`whats-proxy do story-reply '{"message_id":"C78258FE...","text":"*Great shot* — where was this taken?"}'\`
        → {"status":"sent","to":"156263862272061@lid","message_id":"MNO345"}
    - Reply to a story not in store (error):
        \`whats-proxy do story-reply '{"message_id":"NONEXISTENT","text":"Hi"}'\`
        → {"meta":{"status":"error","comment":"Story NONEXISTENT not found in store.","edited":false},"data":{"error":"Story NONEXISTENT not found in store."}}`,
  },
  {
    meta: {
      action: "story-delete",
      category: "stories",
      description:
        "Delete your own story from your status. The story must be in the local store and must be yours (fromMe=true). Sends a revoke protocol message to status@broadcast.",
      arguments: [
        { name: "message_id", description: "Story message ID to delete.", required: true },
      ],
      example: { message_id: "A56036DC..." },
      returns: "{ status, message_id }",
    },
    handler: requireApproval("default")(async ({ message_id }, { sock, store }) => {
      const msg = store.getMessage(String(message_id));
      if (!msg) return errResult(`Story ${message_id} not found in store.`);
      if (!msg?.key?.fromMe) return errResult("You can only delete your own stories.");
      const result = await sock.sendMessage(STATUS_BROADCAST, { delete: msg.key } as never);
      return okResult({ status: "deleted", message_id, revoke: result?.key?.id || null });
    }),
    schema: storyDeleteSchema,
    docstring: `Delete your own story from your status.

Parameters:
    - message_id (required): Story message ID to delete.

Examples:
    - Delete your own story:
        \`whats-proxy do story-delete '{"message_id":"A56036DC..."}'\`
        → {"status":"deleted","message_id":"A56036DC...","revoke":"REV001"}
    - Try to delete someone else's story (error):
        \`whats-proxy do story-delete '{"message_id":"C78258FE..."}'\`
        → {"meta":{"status":"error","comment":"You can only delete your own stories.","edited":false},"data":{"error":"You can only delete your own stories."}}
    - Story not in store (error):
        \`whats-proxy do story-delete '{"message_id":"NONEXISTENT"}'\`
        → {"meta":{"status":"error","comment":"Story NONEXISTENT not found in store.","edited":false},"data":{"error":"Story NONEXISTENT not found in store."}}`,
  },
] satisfies ActionDef[];
