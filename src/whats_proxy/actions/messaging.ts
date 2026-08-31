/**
 * whats-proxy — Messaging actions (15).
 *
 * send-text, send-image, send-video, send-audio, send-document, send-sticker,
 * send-location, send-contact, send-reaction, send-poll, edit-message,
 * delete-message, forward-message, batch-send-text, send-batch.
 *
 * Faithful port of whats-mcp `messaging.js` + unified send-batch.
 */

import type { ActionDef } from "./types.ts";
import { phoneToJid, resolveMedia, okResult, errResult } from "../helpers.ts";
import {
  sendTextSchema, sendImageSchema, sendVideoSchema, sendAudioSchema,
  sendDocumentSchema, sendStickerSchema, sendLocationSchema, sendContactSchema,
  sendReactionSchema, sendPollSchema, editMessageSchema, deleteMessageSchema,
  forwardMessageSchema, batchSendTextSchema, sendBatchSchema,
} from "./schemas.ts";
import type { AnyMsg } from "../store.ts";

function _buildSendOpts(args: Record<string, unknown>, store: { getMessage(id: string): AnyMsg | null }) {
  const opts: Record<string, unknown> = {};
  if (args.quoted_id) {
    const quoted = store.getMessage(String(args.quoted_id));
    if (quoted) opts.quoted = quoted;
  }
  if (Array.isArray(args.mentions)) {
    opts.mentions = args.mentions;
  }
  return opts;
}

function _fmtSent(result: any, jid: string) {
  return okResult({
    status: "sent",
    jid,
    message_id: result?.key?.id || null,
    timestamp: result?.messageTimestamp
      ? Number(result.messageTimestamp)
      : Math.floor(Date.now() / 1000),
  });
}

/** Map a send-batch part to a Baileys content object. */
function _mapPart(part: Record<string, unknown>): Record<string, unknown> {
  switch (part.type) {
    case "text": {
      const c: Record<string, unknown> = { text: String(part.text) };
      if (Array.isArray(part.mentions) && part.mentions.length > 0) {
        c.mentions = part.mentions;
      }
      return c;
    }
    case "image":
      return { image: resolveMedia(String(part.source)) as any, ...(part.caption ? { caption: part.caption } : {}) };
    case "video": {
      const c: Record<string, unknown> = { video: resolveMedia(String(part.source)) as any };
      if (part.caption) c.caption = part.caption;
      if (part.gif_playback) c.gifPlayback = true;
      if (part.ptv) c.ptv = true;
      return c;
    }
    case "audio": {
      const c: Record<string, unknown> = { audio: resolveMedia(String(part.source)) as any };
      if (part.ptt) c.ptt = true;
      return c;
    }
    case "document": {
      const c: Record<string, unknown> = {
        document: resolveMedia(String(part.source)) as any,
        mimetype: String(part.mimetype || "application/octet-stream"),
      };
      if (part.filename) c.fileName = part.filename;
      if (part.caption) c.caption = part.caption;
      return c;
    }
    case "sticker":
      return { sticker: resolveMedia(String(part.source)) as any };
    case "location": {
      const loc: Record<string, unknown> = {
        degreesLatitude: Number(part.latitude),
        degreesLongitude: Number(part.longitude),
      };
      if (part.name) loc.name = part.name;
      if (part.address) loc.address = part.address;
      return { location: loc };
    }
    case "contact": {
      const list = (part.contacts as { name: string; phone: string }[]) || [];
      const vCards = list.map((c) => {
        const phone = String(c.phone).replace(/[^0-9+]/g, "");
        return (
          "BEGIN:VCARD\nVERSION:3.0\n" +
          `FN:${c.name}\n` +
          `TEL;type=CELL;type=VOICE;waid=${phone.replace("+", "")}:${phone}\n` +
          "END:VCARD"
        );
      });
      return {
        contacts: {
          displayName: list.length === 1 ? list[0]!.name : `${list.length} contacts`,
          contacts: vCards.map((vcard) => ({ vcard })),
        },
      };
    }
    case "poll": {
      const opts = Array.isArray(part.options) ? part.options.map(String) : [];
      return {
        poll: {
          name: String(part.question),
          values: opts,
          selectableCount: part.selectable_count ?? 1,
        },
      };
    }
    default:
      return {};
  }
}

export default [
  {
    meta: {
      action: "send-text",
      category: "messaging",
      description:
        "Send a text message to a contact or group. Supports @mentions and replying to a specific message via quoted_id. The jid can be a phone number (e.g. 33612345678) or full JID.",
      arguments: [
        { name: "jid", description: "Recipient: phone number or full JID (e.g. 33612345678@s.whatsapp.net or 120363xxx@g.us)", required: true },
        { name: "text", description: "Message text. Supports WhatsApp formatting: *bold*, _italic_, ~strikethrough~, ```code```.", required: true },
        { name: "quoted_id", description: "Optional: message ID to reply/quote.", required: false },
        { name: "mentions", description: "Optional: array of JIDs to @mention.", required: false },
      ],
      example: { jid: "33612345678", text: "Hello!" },
      examples: [
        { description: "Direct contact text", payload: { jid: "33612345678", text: "Hello, are you available at 14:00?" } },
        { description: "Formatted group update", payload: { jid: "120363000000000@g.us", text: "*Sprint update*\n- Tests green\n- Review pending" } },
        { description: "Reply and mention", payload: { jid: "120363000000000@g.us", text: "@Alice, noted.", quoted_id: "ABC123", mentions: ["33600000000@s.whatsapp.net"] } },
      ],
      returns: "{ status, jid, message_id, timestamp }",
    },
    handler: async ({ jid, text, quoted_id, mentions }, { sock, store }) => {
      const to = phoneToJid(String(jid));
      const content: Record<string, unknown> = { text: String(text) };
      const opts = _buildSendOpts({ quoted_id, mentions }, store);
      if (mentions) content.mentions = mentions;
      const result = await sock.sendMessage(to, content as any, opts as any);
      return _fmtSent(result, to);
    },
    schema: sendTextSchema,
    docstring: `Send a text message to a contact or group. Supports @mentions and replying to a specific message via quoted_id.

Parameters:
    - jid (required): Recipient JID or phone number.
    - text (required): Message text. Supports *bold*, _italic_, ~strikethrough~.
    - quoted_id (optional): Message ID to reply to.
    - mentions (optional): Array of JIDs to @mention.

Examples:
    - Send a text message:
        \`whats-proxy do send-text '{"jid":"33612345678","text":"Hello!"}'\`
        → {"status":"sent","jid":"33612345678@s.whatsapp.net","message_id":"ABC123","timestamp":1756614000}
    - Reply to a specific message:
        \`whats-proxy do send-text '{"jid":"33612345678","text":"Replying here","quoted_id":"MSG456"}'\`
        → {"status":"sent","jid":"33612345678@s.whatsapp.net","message_id":"DEF789","timestamp":1756614001}
    - Text with mentions in a group:
        \`whats-proxy do send-text '{"jid":"120363xxx@g.us","text":"@Alice check this","mentions":["33600000000@s.whatsapp.net"]}'\`
        → {"status":"sent","jid":"120363xxx@g.us","message_id":"GHI012","timestamp":1756614002}`,
  },
  {
    meta: {
      action: "send-image",
      category: "messaging",
      description: "Send an image to a contact or group. Media source can be a URL (https://...), base64 data, or local file path.",
      arguments: [
        { name: "jid", description: "Recipient JID or phone number.", required: true },
        { name: "source", description: "Image source: URL, base64 string, or local file path.", required: true },
        { name: "caption", description: "Optional caption for the image.", required: false },
        { name: "quoted_id", description: "Optional: message ID to reply/quote.", required: false },
      ],
      example: { jid: "33612345678", source: "/path/to/image.jpg", caption: "Look!" },
      examples: [
        { description: "Local image with caption", payload: { jid: "33612345678", source: "/home/user/Pictures/diagram.png", caption: "Architecture diagram" } },
        { description: "Remote image", payload: { jid: "120363000000000@g.us", source: "https://example.com/announcement.jpg", caption: "Announcement" } },
        { description: "Reply with an image", payload: { jid: "33612345678", source: "/home/user/Pictures/receipt.jpg", quoted_id: "ABC123" } },
      ],
      returns: "{ status, jid, message_id, timestamp }",
    },
    handler: async ({ jid, source, caption, quoted_id }, { sock, store }) => {
      const to = phoneToJid(String(jid));
      const content: Record<string, unknown> = { image: resolveMedia(String(source)) as any };
      if (caption) content.caption = caption;
      const opts = _buildSendOpts({ quoted_id }, store);
      const result = await sock.sendMessage(to, content as any, opts as any);
      return _fmtSent(result, to);
    },
    schema: sendImageSchema,
    docstring: `Send an image to a contact or group. Media source can be a URL, base64 data, or local file path.

Parameters:
    - jid (required): Recipient JID or phone number.
    - source (required): Image source: URL, base64 string, or local file path.
    - caption (optional): Caption for the image.
    - quoted_id (optional): Message ID to reply to.

Examples:
    - Send a local image with caption:
        \`whats-proxy do send-image '{"jid":"33612345678","source":"/home/user/Pictures/diagram.png","caption":"Architecture diagram"}'\`
        → {"status":"sent","jid":"33612345678@s.whatsapp.net","message_id":"IMG001","timestamp":1756614000}
    - Send a remote image to a group:
        \`whats-proxy do send-image '{"jid":"120363000000000@g.us","source":"https://example.com/announcement.jpg","caption":"Announcement"}'\`
        → {"status":"sent","jid":"120363000000000@g.us","message_id":"IMG002","timestamp":1756614001}
    - Reply with an image:
        \`whats-proxy do send-image '{"jid":"33612345678","source":"/home/user/Pictures/receipt.jpg","quoted_id":"ABC123"}'\`
        → {"status":"sent","jid":"33612345678@s.whatsapp.net","message_id":"IMG003","timestamp":1756614002}`,
  },
  {
    meta: {
      action: "send-video",
      category: "messaging",
      description: "Send a video to a contact or group. Set gif_playback=true for a GIF, or ptv=true for a video note (circle).",
      arguments: [
        { name: "jid", description: "Recipient JID or phone number.", required: true },
        { name: "source", description: "Video source: URL, base64, or local path.", required: true },
        { name: "caption", description: "Optional caption.", required: false },
        { name: "gif_playback", description: "Send as GIF (auto-playing, no sound). Default false.", required: false },
        { name: "ptv", description: "Send as video note / circle message. Default false.", required: false },
        { name: "quoted_id", description: "Optional: message ID to reply/quote.", required: false },
      ],
      example: { jid: "33612345678", source: "/path/to/video.mp4", caption: "Watch this" },
      examples: [
        { description: "Local video", payload: { jid: "33612345678", source: "/home/user/Videos/demo.mp4", caption: "Demo recording" } },
        { description: "GIF playback", payload: { jid: "120363000000000@g.us", source: "/home/user/Videos/loop.mp4", gif_playback: true } },
        { description: "Video note", payload: { jid: "33612345678", source: "/home/user/Videos/answer.mp4", ptv: true } },
      ],
      returns: "{ status, jid, message_id, timestamp }",
    },
    handler: async ({ jid, source, caption, gif_playback, ptv, quoted_id }, { sock, store }) => {
      const to = phoneToJid(String(jid));
      const content: Record<string, unknown> = { video: resolveMedia(String(source)) as any };
      if (caption) content.caption = caption;
      if (gif_playback) content.gifPlayback = true;
      if (ptv) content.ptv = true;
      const opts = _buildSendOpts({ quoted_id }, store);
      const result = await sock.sendMessage(to, content as any, opts as any);
      return _fmtSent(result, to);
    },
    schema: sendVideoSchema,
    docstring: `Send a video to a contact or group. Set gif_playback=true for a GIF, or ptv=true for a video note (circle).

Parameters:
    - jid (required): Recipient JID or phone number.
    - source (required): Video source: URL, base64, or local path.
    - caption (optional): Caption for the video.
    - gif_playback (optional): Send as GIF. Default false.
    - ptv (optional): Send as video note / circle message. Default false.
    - quoted_id (optional): Message ID to reply to.

Examples:
    - Send a local video with caption:
        \`whats-proxy do send-video '{"jid":"33612345678","source":"/home/user/Videos/demo.mp4","caption":"Demo recording"}'\`
        → {"status":"sent","jid":"33612345678@s.whatsapp.net","message_id":"VID001","timestamp":1756614000}
    - Send as GIF to a group:
        \`whats-proxy do send-video '{"jid":"120363000000000@g.us","source":"/home/user/Videos/loop.mp4","gif_playback":true}'\`
        → {"status":"sent","jid":"120363000000000@g.us","message_id":"VID002","timestamp":1756614001}
    - Send as video note:
        \`whats-proxy do send-video '{"jid":"33612345678","source":"/home/user/Videos/answer.mp4","ptv":true}'\`
        → {"status":"sent","jid":"33612345678@s.whatsapp.net","message_id":"VID003","timestamp":1756614002}`,
  },
  {
    meta: {
      action: "send-audio",
      category: "messaging",
      description: "Send an audio file or voice note. Set ptt=true to send as a voice note (push-to-talk style).",
      arguments: [
        { name: "jid", description: "Recipient JID or phone number.", required: true },
        { name: "source", description: "Audio source: URL, base64, or local path.", required: true },
        { name: "ptt", description: "Send as voice note (push-to-talk). Default false.", required: false },
        { name: "quoted_id", description: "Optional: message ID to reply/quote.", required: false },
      ],
      example: { jid: "33612345678", source: "/path/to/audio.mp3", ptt: false },
      returns: "{ status, jid, message_id, timestamp }",
    },
    handler: async ({ jid, source, ptt, quoted_id }, { sock, store }) => {
      const to = phoneToJid(String(jid));
      const content: Record<string, unknown> = { audio: resolveMedia(String(source)) as any };
      if (ptt) content.ptt = true;
      const opts = _buildSendOpts({ quoted_id }, store);
      const result = await sock.sendMessage(to, content as any, opts as any);
      return _fmtSent(result, to);
    },
    schema: sendAudioSchema,
    docstring: `Send an audio file or voice note. Set ptt=true to send as a voice note (push-to-talk style).

Parameters:
    - jid (required): Recipient JID or phone number.
    - source (required): Audio source: URL, base64, or local path.
    - ptt (optional): Send as voice note (push-to-talk). Default false.
    - quoted_id (optional): Message ID to reply to.

Examples:
    - Send an audio file:
        \`whats-proxy do send-audio '{"jid":"33612345678","source":"/home/user/Music/song.mp3"}'\`
        → {"status":"sent","jid":"33612345678@s.whatsapp.net","message_id":"AUD001","timestamp":1756614000}
    - Send a voice note:
        \`whats-proxy do send-audio '{"jid":"33612345678","source":"/home/user/recordings/note.ogg","ptt":true}'\`
        → {"status":"sent","jid":"33612345678@s.whatsapp.net","message_id":"AUD002","timestamp":1756614001}
    - Reply with audio:
        \`whats-proxy do send-audio '{"jid":"120363000000000@g.us","source":"https://example.com/podcast.mp3","quoted_id":"MSG123"}'\`
        → {"status":"sent","jid":"120363000000000@g.us","message_id":"AUD003","timestamp":1756614002}`,
  },
  {
    meta: {
      action: "send-document",
      category: "messaging",
      description: "Send a document/file to a contact or group. Supports any file type — specify mimetype and filename.",
      arguments: [
        { name: "jid", description: "Recipient JID or phone number.", required: true },
        { name: "source", description: "Document source: URL, base64, or local path.", required: true },
        { name: "filename", description: "Display filename (e.g. 'report.pdf').", required: false },
        { name: "mimetype", description: "MIME type (e.g. 'application/pdf'). Auto-detected if omitted.", required: false },
        { name: "caption", description: "Optional caption.", required: false },
        { name: "quoted_id", description: "Optional: message ID to reply/quote.", required: false },
      ],
      example: { jid: "33612345678", source: "/path/to/report.pdf", filename: "report.pdf" },
      examples: [
        { description: "Local PDF", payload: { jid: "33612345678", source: "/home/user/Documents/report.pdf", filename: "report.pdf", mimetype: "application/pdf" } },
        { description: "Remote document", payload: { jid: "120363000000000@g.us", source: "https://example.com/agenda.pdf", filename: "agenda.pdf" } },
        { description: "Document reply", payload: { jid: "33612345678", source: "/home/user/Documents/answer.pdf", quoted_id: "ABC123" } },
      ],
      returns: "{ status, jid, message_id, timestamp }",
    },
    handler: async ({ jid, source, filename, mimetype, caption, quoted_id }, { sock, store }) => {
      const to = phoneToJid(String(jid));
      const content: Record<string, unknown> = {
        document: resolveMedia(String(source)) as any,
        mimetype: String(mimetype || "application/octet-stream"),
      };
      if (filename) content.fileName = filename;
      if (caption) content.caption = caption;
      const opts = _buildSendOpts({ quoted_id }, store);
      const result = await sock.sendMessage(to, content as any, opts as any);
      return _fmtSent(result, to);
    },
    schema: sendDocumentSchema,
    docstring: `Send a document/file to a contact or group. Supports any file type.

Parameters:
    - jid (required): Recipient JID or phone number.
    - source (required): Document source: URL, base64, or local path.
    - filename (optional): Display filename (e.g. 'report.pdf').
    - mimetype (optional): MIME type (e.g. 'application/pdf'). Auto-detected if omitted.
    - caption (optional): Caption for the document.
    - quoted_id (optional): Message ID to reply to.

Examples:
    - Send a local PDF:
        \`whats-proxy do send-document '{"jid":"33612345678","source":"/home/user/Documents/report.pdf","filename":"report.pdf","mimetype":"application/pdf"}'\`
        → {"status":"sent","jid":"33612345678@s.whatsapp.net","message_id":"DOC001","timestamp":1756614000}
    - Send a remote document to a group:
        \`whats-proxy do send-document '{"jid":"120363000000000@g.us","source":"https://example.com/agenda.pdf","filename":"agenda.pdf"}'\`
        → {"status":"sent","jid":"120363000000000@g.us","message_id":"DOC002","timestamp":1756614001}
    - Reply with a document:
        \`whats-proxy do send-document '{"jid":"33612345678","source":"/home/user/Documents/answer.pdf","quoted_id":"ABC123"}'\`
        → {"status":"sent","jid":"33612345678@s.whatsapp.net","message_id":"DOC003","timestamp":1756614002}`,
  },
  {
    meta: {
      action: "send-sticker",
      category: "messaging",
      description: "Send a sticker (WebP format recommended).",
      arguments: [
        { name: "jid", description: "Recipient JID or phone number.", required: true },
        { name: "source", description: "Sticker image source: URL, base64, or local path (WebP format).", required: true },
        { name: "quoted_id", description: "Optional: message ID to reply/quote.", required: false },
      ],
      example: { jid: "33612345678", source: "/path/to/sticker.webp" },
      returns: "{ status, jid, message_id, timestamp }",
    },
    handler: async ({ jid, source, quoted_id }, { sock, store }) => {
      const to = phoneToJid(String(jid));
      const content = { sticker: resolveMedia(String(source)) as any };
      const opts = _buildSendOpts({ quoted_id }, store);
      const result = await sock.sendMessage(to, content as any, opts as any);
      return _fmtSent(result, to);
    },
    schema: sendStickerSchema,
    docstring: `Send a sticker (WebP format recommended).

Parameters:
    - jid (required): Recipient JID or phone number.
    - source (required): Sticker image source: URL, base64, or local path (WebP format).
    - quoted_id (optional): Message ID to reply to.

Examples:
    - Send a local sticker:
        \`whats-proxy do send-sticker '{"jid":"33612345678","source":"/home/user/Stickers/funny.webp"}'\`
        → {"status":"sent","jid":"33612345678@s.whatsapp.net","message_id":"STK001","timestamp":1756614000}
    - Send a remote sticker to a group:
        \`whats-proxy do send-sticker '{"jid":"120363000000000@g.us","source":"https://example.com/meme.webp"}'\`
        → {"status":"sent","jid":"120363000000000@g.us","message_id":"STK002","timestamp":1756614001}
    - Reply with a sticker:
        \`whats-proxy do send-sticker '{"jid":"33612345678","source":"/home/user/Stickers/emoji.webp","quoted_id":"MSG456"}'\`
        → {"status":"sent","jid":"33612345678@s.whatsapp.net","message_id":"STK003","timestamp":1756614002}`,
  },
  {
    meta: {
      action: "send-location",
      category: "messaging",
      description: "Send a GPS location pin.",
      arguments: [
        { name: "jid", description: "Recipient JID or phone number.", required: true },
        { name: "latitude", description: "Latitude (decimal degrees).", required: true },
        { name: "longitude", description: "Longitude (decimal degrees).", required: true },
        { name: "name", description: "Optional location name.", required: false },
        { name: "address", description: "Optional address text.", required: false },
        { name: "quoted_id", description: "Optional: message ID to reply/quote.", required: false },
      ],
      example: { jid: "33612345678", latitude: 48.8566, longitude: 2.3522, name: "Paris" },
      returns: "{ status, jid, message_id, timestamp }",
    },
    handler: async ({ jid, latitude, longitude, name, address, quoted_id }, { sock, store }) => {
      const to = phoneToJid(String(jid));
      const content: Record<string, unknown> = {
        location: {
          degreesLatitude: Number(latitude),
          degreesLongitude: Number(longitude),
        },
      };
      const loc = content.location as Record<string, unknown>;
      if (name) loc.name = name;
      if (address) loc.address = address;
      const opts = _buildSendOpts({ quoted_id }, store);
      const result = await sock.sendMessage(to, content as any, opts as any);
      return _fmtSent(result, to);
    },
    schema: sendLocationSchema,
    docstring: `Send a GPS location pin.

Parameters:
    - jid (required): Recipient JID or phone number.
    - latitude (required): Latitude (decimal degrees).
    - longitude (required): Longitude (decimal degrees).
    - name (optional): Location name.
    - address (optional): Address text.
    - quoted_id (optional): Message ID to reply to.

Examples:
    - Send a named location:
        \`whats-proxy do send-location '{"jid":"33612345678","latitude":48.8566,"longitude":2.3522,"name":"Paris","address":"France"}'\`
        → {"status":"sent","jid":"33612345678@s.whatsapp.net","message_id":"LOC001","timestamp":1756614000}
    - Send coordinates without name:
        \`whats-proxy do send-location '{"jid":"120363000000000@g.us","latitude":45.7640,"longitude":4.8357}'\`
        → {"status":"sent","jid":"120363000000000@g.us","message_id":"LOC002","timestamp":1756614001}
    - Reply with a location:
        \`whats-proxy do send-location '{"jid":"33612345678","latitude":51.5074,"longitude":-0.1278,"name":"London","quoted_id":"MSG789"}'\`
        → {"status":"sent","jid":"33612345678@s.whatsapp.net","message_id":"LOC003","timestamp":1756614002}`,
  },
  {
    meta: {
      action: "send-contact",
      category: "messaging",
      description: "Send one or more contact cards (vCards).",
      arguments: [
        { name: "jid", description: "Recipient JID or phone number.", required: true },
        { name: "contacts", description: "Array of { name, phone } objects to send.", required: true },
        { name: "quoted_id", description: "Optional: message ID to reply/quote.", required: false },
      ],
      example: { jid: "33612345678", contacts: [{ name: "Alice", phone: "33600000000" }] },
      returns: "{ status, jid, message_id, timestamp }",
    },
    handler: async ({ jid, contacts, quoted_id }, { sock, store }) => {
      const to = phoneToJid(String(jid));
      const list = (contacts as { name: string; phone: string }[]) || [];
      const vCards = list.map((c) => {
        const phone = String(c.phone).replace(/[^0-9+]/g, "");
        return (
          "BEGIN:VCARD\n" +
          "VERSION:3.0\n" +
          `FN:${c.name}\n` +
          `TEL;type=CELL;type=VOICE;waid=${phone.replace("+", "")}:${phone}\n` +
          "END:VCARD"
        );
      });
      const content = {
        contacts: {
          displayName: list.length === 1 ? list[0]!.name : `${list.length} contacts`,
          contacts: vCards.map((vcard) => ({ vcard })),
        },
      };
      const opts = _buildSendOpts({ quoted_id }, store);
      const result = await sock.sendMessage(to, content as any, opts as any);
      return _fmtSent(result, to);
    },
    schema: sendContactSchema,
    docstring: `Send one or more contact cards (vCards).

Parameters:
    - jid (required): Recipient JID or phone number.
    - contacts (required): Array of { name, phone } objects to send.
    - quoted_id (optional): Message ID to reply to.

Examples:
    - Send a single contact:
        \`whats-proxy do send-contact '{"jid":"33612345678","contacts":[{"name":"Alice","phone":"33600000000"}]}'\`
        → {"status":"sent","jid":"33612345678@s.whatsapp.net","message_id":"CON001","timestamp":1756614000}
    - Send multiple contacts:
        \`whats-proxy do send-contact '{"jid":"120363000000000@g.us","contacts":[{"name":"Alice","phone":"33600000000"},{"name":"Bob","phone":"33611111111"}]}'\`
        → {"status":"sent","jid":"120363000000000@g.us","message_id":"CON002","timestamp":1756614001}
    - Reply with a contact card:
        \`whats-proxy do send-contact '{"jid":"33612345678","contacts":[{"name":"Support","phone":"33622222222"}],"quoted_id":"MSG123"}'\`
        → {"status":"sent","jid":"33612345678@s.whatsapp.net","message_id":"CON003","timestamp":1756614002}`,
  },
  {
    meta: {
      action: "send-reaction",
      category: "messaging",
      description: "React to a message with an emoji. Send an empty emoji string to remove the reaction.",
      arguments: [
        { name: "jid", description: "Chat JID where the message is.", required: true },
        { name: "message_id", description: "ID of the message to react to.", required: true },
        { name: "emoji", description: "Emoji reaction (e.g. '👍', '❤️'). Empty string to remove.", required: true },
        { name: "from_me", description: "Whether the target message was sent by you. Default false.", required: false },
      ],
      example: { jid: "33612345678", message_id: "ABC123", emoji: "👍" },
      returns: "{ status, jid, message_id, emoji }",
    },
    handler: async ({ jid, message_id, emoji, from_me }, { sock }) => {
      const to = phoneToJid(String(jid));
      const content = {
        react: {
          text: String(emoji),
          key: {
            remoteJid: to,
            id: String(message_id),
            fromMe: from_me ?? false,
          },
        },
      };
      await sock.sendMessage(to, content as any);
      return okResult({
        status: emoji ? "reacted" : "reaction_removed",
        jid: to,
        message_id,
        emoji: emoji || null,
      });
    },
    schema: sendReactionSchema,
    docstring: `React to a message with an emoji. Send an empty emoji string to remove the reaction.

Parameters:
    - jid (required): Chat JID where the message is.
    - message_id (required): ID of the message to react to.
    - emoji (required): Emoji reaction (e.g. '👍', '❤️'). Empty string to remove.
    - from_me (optional): Whether the target message was sent by you. Default false.

Examples:
    - React with a thumbs up:
        \`whats-proxy do send-reaction '{"jid":"33612345678","message_id":"ABC123","emoji":"👍"}'\`
        → {"status":"reacted","jid":"33612345678@s.whatsapp.net","message_id":"ABC123","emoji":"👍"}
    - React to your own message:
        \`whats-proxy do send-reaction '{"jid":"120363000000000@g.us","message_id":"MSG456","emoji":"❤️","from_me":true}'\`
        → {"status":"reacted","jid":"120363000000000@g.us","message_id":"MSG456","emoji":"❤️"}
    - Remove a reaction:
        \`whats-proxy do send-reaction '{"jid":"33612345678","message_id":"ABC123","emoji":""}'\`
        → {"status":"reaction_removed","jid":"33612345678@s.whatsapp.net","message_id":"ABC123","emoji":null}`,
  },
  {
    meta: {
      action: "send-poll",
      category: "messaging",
      description: "Create a poll in a chat. By default single-select; set selectable_count > 1 for multi-select.",
      arguments: [
        { name: "jid", description: "Recipient JID or phone number.", required: true },
        { name: "question", description: "Poll question text.", required: true },
        { name: "options", description: "Array of poll option strings (2-12).", required: true },
        { name: "selectable_count", description: "How many options can be selected (default 1 = single-select).", required: false },
      ],
      example: { jid: "33612345678", question: "Lunch?", options: ["Pizza", "Sushi"] },
      returns: "{ status, jid, message_id, timestamp }",
    },
    handler: async ({ jid, question, options, selectable_count }, { sock }) => {
      const opts = Array.isArray(options) ? options.map(String) : [];
      if (opts.length < 2) {
        return errResult("A poll requires at least 2 options.");
      }
      const to = phoneToJid(String(jid));
      const content = {
        poll: {
          name: String(question),
          values: opts,
          selectableCount: selectable_count ?? 1,
        },
      };
      const result = await sock.sendMessage(to, content as any);
      return _fmtSent(result, to);
    },
    schema: sendPollSchema,
    docstring: `Create a poll in a chat. By default single-select; set selectable_count > 1 for multi-select.

Parameters:
    - jid (required): Recipient JID or phone number.
    - question (required): Poll question text.
    - options (required): Array of poll option strings (2-12).
    - selectable_count (optional): How many options can be selected (default 1).

Examples:
    - Single-select poll:
        \`whats-proxy do send-poll '{"jid":"33612345678","question":"Lunch?","options":["Pizza","Sushi","Tacos"]}'\`
        → {"status":"sent","jid":"33612345678@s.whatsapp.net","message_id":"POLL001","timestamp":1756614000}
    - Multi-select poll in a group:
        \`whats-proxy do send-poll '{"jid":"120363000000000@g.us","question":"Topics for next meeting?","options:["Sprint","Roadblock","Demo"],"selectable_count":3}'\`
        → {"status":"sent","jid":"120363000000000@g.us","message_id":"POLL002","timestamp":1756614001}
    - Poll with error (too few options):
        \`whats-proxy do send-poll '{"jid":"33612345678","question":"Vote?","options":["Yes"]}'\`
        → {"meta":{"status":"error","comment":"A poll requires at least 2 options.","edited":false},"data":{"error":"A poll requires at least 2 options."}}`,
  },
  {
    meta: {
      action: "edit-message",
      category: "messaging",
      description: "Edit a previously sent message (text only). You can only edit messages you sent.",
      arguments: [
        { name: "jid", description: "Chat JID where the message is.", required: true },
        { name: "message_id", description: "ID of the message to edit.", required: true },
        { name: "new_text", description: "New text content.", required: true },
      ],
      example: { jid: "33612345678", message_id: "ABC123", new_text: "Updated text" },
      returns: "{ status, jid, message_id }",
    },
    handler: async ({ jid, message_id, new_text }, { sock }) => {
      const to = phoneToJid(String(jid));
      const content = {
        text: String(new_text),
        edit: { remoteJid: to, id: String(message_id), fromMe: true },
      };
      await sock.sendMessage(to, content as any);
      return okResult({ status: "edited", jid: to, message_id });
    },
    schema: editMessageSchema,
    docstring: `Edit a previously sent message (text only). You can only edit messages you sent.

Parameters:
    - jid (required): Chat JID where the message is.
    - message_id (required): ID of the message to edit.
    - new_text (required): New text content.

Examples:
    - Fix a typo:
        \`whats-proxy do edit-message '{"jid":"33612345678","message_id":"ABC123","new_text":"Hello, meeting at 15:00"}'\`
        → {"status":"edited","jid":"33612345678@s.whatsapp.net","message_id":"ABC123"}
    - Edit a group announcement:
        \`whats-proxy do edit-message '{"jid":"120363000000000@g.us","message_id":"MSG456","new_text":"*Updated*\nSprint moved to Thursday"}'\`
        → {"status":"edited","jid":"120363000000000@g.us","message_id":"MSG456"}
    - Edit with formatting:
        \`whats-proxy do edit-message '{"jid":"33612345678","message_id":"MSG789","new_text":"*Important* deadline: *Friday* 18:00"}'\`
        → {"status":"edited","jid":"33612345678@s.whatsapp.net","message_id":"MSG789"}`,
  },
  {
    meta: {
      action: "delete-message",
      category: "messaging",
      description: "Delete (revoke) a message. You can delete your own messages for everyone, or in groups admins can delete anyone's messages.",
      arguments: [
        { name: "jid", description: "Chat JID.", required: true },
        { name: "message_id", description: "ID of the message to delete.", required: true },
        { name: "from_me", description: "Whether you sent the message. Default true.", required: false },
        { name: "participant", description: "In groups: JID of the message sender (required if from_me=false).", required: false },
      ],
      example: { jid: "33612345678", message_id: "ABC123", from_me: true },
      returns: "{ status, jid, message_id }",
    },
    handler: async ({ jid, message_id, from_me, participant }, { sock }) => {
      const to = phoneToJid(String(jid));
      const key: Record<string, unknown> = {
        remoteJid: to,
        id: String(message_id),
        fromMe: from_me ?? true,
      };
      if (participant) key.participant = participant;
      await sock.sendMessage(to, { delete: key } as any);
      return okResult({ status: "deleted", jid: to, message_id });
    },
    schema: deleteMessageSchema,
    docstring: `Delete (revoke) a message. You can delete your own messages for everyone, or in groups admins can delete anyone's messages.

Parameters:
    - jid (required): Chat JID.
    - message_id (required): ID of the message to delete.
    - from_me (optional): Whether you sent the message. Default true.
    - participant (optional): In groups: JID of the message sender (required if from_me=false).

Examples:
    - Delete your own message:
        \`whats-proxy do delete-message '{"jid":"33612345678","message_id":"ABC123","from_me":true}'\`
        → {"status":"deleted","jid":"33612345678@s.whatsapp.net","message_id":"ABC123"}
    - Delete a group message you sent:
        \`whats-proxy do delete-message '{"jid":"120363000000000@g.us","message_id":"MSG456","from_me":true}'\`
        → {"status":"deleted","jid":"120363000000000@g.us","message_id":"MSG456"}
    - Admin delete someone else's message:
        \`whats-proxy do delete-message '{"jid":"120363000000000@g.us","message_id":"MSG789","from_me":false,"participant":"33600000000@s.whatsapp.net"}'\`
        → {"status":"deleted","jid":"120363000000000@g.us","message_id":"MSG789"}`,
  },
  {
    meta: {
      action: "forward-message",
      category: "messaging",
      description: "Forward an existing message to another chat.",
      arguments: [
        { name: "to_jid", description: "Destination JID to forward to.", required: true },
        { name: "message_id", description: "ID of the message to forward.", required: true },
      ],
      example: { to_jid: "33612345678", message_id: "ABC123" },
      returns: "{ status, jid, message_id, timestamp }",
    },
    handler: async ({ to_jid, message_id }, { sock, store }) => {
      const msg = store.getMessage(String(message_id));
      if (!msg) {
        return errResult(`Message ${message_id} not found in store. It must be a recent message.`);
      }
      const to = phoneToJid(String(to_jid));
      const result = await sock.sendMessage(to, { forward: msg, force: true } as any);
      return _fmtSent(result, to);
    },
    schema: forwardMessageSchema,
    docstring: `Forward an existing message to another chat.

Parameters:
    - to_jid (required): Destination JID to forward to.
    - message_id (required): ID of the message to forward.

Examples:
    - Forward to a contact:
        \`whats-proxy do forward-message '{"to_jid":"33612345678","message_id":"ABC123"}'\`
        → {"status":"sent","jid":"33612345678@s.whatsapp.net","message_id":"FWD001","timestamp":1756614000}
    - Forward to a group:
        \`whats-proxy do forward-message '{"to_jid":"120363000000000@g.us","message_id":"MSG456"}'\`
        → {"status":"sent","jid":"120363000000000@g.us","message_id":"FWD002","timestamp":1756614001}
    - Forward with error (message not found):
        \`whats-proxy do forward-message '{"to_jid":"33612345678","message_id":"NONEXISTENT"}'\`
        → {"meta":{"status":"error","comment":"Message NONEXISTENT not found in store. It must be a recent message.","edited":false},"data":{"error":"Message NONEXISTENT not found in store. It must be a recent message."}}`,
  },
  {
    meta: {
      action: "batch-send-text",
      category: "messaging",
      description: "Send the same text message to multiple recipients. Returns a summary of successes and failures.",
      arguments: [
        { name: "jids", description: "Array of recipient JIDs or phone numbers.", required: true },
        { name: "text", description: "Message text to send to all recipients.", required: true },
        { name: "delay_ms", description: "Delay in ms between sends to avoid rate-limiting. Default 1000.", required: false },
      ],
      example: { jids: ["33612345678", "33600000000"], text: "Hi all!" },
      examples: [
        { description: "Two contacts", payload: { jids: ["33612345678", "33600000000"], text: "Meeting starts in ten minutes." } },
        { description: "Contacts and a group", payload: { jids: ["33612345678", "120363000000000@g.us"], text: "The document is ready." } },
        { description: "Rate-limited broadcast", payload: { jids: ["33612345678", "33600000000"], text: "*Reminder*\nPlease confirm attendance.", delay_ms: 1500 } },
      ],
      returns: "{ total, sent, failed, results }",
    },
    handler: async ({ jids, text, delay_ms }, { sock }) => {
      const list = Array.isArray(jids) ? jids.map(String) : [];
      if (list.length === 0) {
        return errResult("At least one recipient is required.");
      }
      const delay = delay_ms !== undefined ? Number(delay_ms) : 1000;
      const results: Record<string, unknown>[] = [];
      for (const jid of list) {
        const to = phoneToJid(jid);
        try {
          const r: any = await sock.sendMessage(to, { text: String(text) } as any);
          results.push({ jid: to, status: "sent", message_id: r?.key?.id || null });
        } catch (err) {
          results.push({ jid: to, status: "failed", error: (err as Error).message });
        }
        const idx = list.indexOf(jid);
        if (delay > 0 && idx < list.length - 1) {
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      const sent = results.filter((r) => r.status === "sent").length;
      const failed = results.filter((r) => r.status === "failed").length;
      return okResult({ total: list.length, sent, failed, results });
    },
    schema: batchSendTextSchema,
    docstring: `Send the same text message to multiple recipients. Returns a summary of successes and failures.

Parameters:
    - jids (required): Array of recipient JIDs or phone numbers.
    - text (required): Message text to send to all recipients.
    - delay_ms (optional): Delay in ms between sends to avoid rate-limiting. Default 1000.

Examples:
    - Broadcast to two contacts:
        \`whats-proxy do batch-send-text '{"jids":["33612345678","33600000000"],"text":"Meeting starts in ten minutes."}'\`
        → {"total":2,"sent":2,"failed":0,"results":[{"jid":"33612345678@s.whatsapp.net","status":"sent","message_id":"BATCH001"},{"jid":"33600000000@s.whatsapp.net","status":"sent","message_id":"BATCH002"}]}
    - Broadcast with rate limiting:
        \`whats-proxy do batch-send-text '{"jids":["33612345678","33600000000"],"text":"*Reminder*\nPlease confirm attendance.","delay_ms":1500}'\`
        → {"total":2,"sent":2,"failed":0,"results":[{"jid":"33612345678@s.whatsapp.net","status":"sent","message_id":"BATCH003"},{"jid":"33600000000@s.whatsapp.net","status":"sent","message_id":"BATCH004"}]}
    - Broadcast with some failures:
        \`whats-proxy do batch-send-text '{"jids":["33612345678","invalid"],"text":"Hello!"}'\`
        → {"total":2,"sent":1,"failed":1,"results":[{"jid":"33612345678@s.whatsapp.net","status":"sent","message_id":"BATCH005"},{"jid":"invalid@s.whatsapp.net","status":"failed","error":"Invalid JID"}]}`,
  },
  // ── send-batch: unified multi-recipient multi-part send ──────────────────
  {
    meta: {
      action: "send-batch",
      category: "messaging",
      description: "Send multiple content types (text, image, video, audio, document, sticker, location, contact, poll) to one or more recipients in a single call. Each part becomes one WhatsApp message; every part is sent to every recipient. Text parts support @mentions. Any part can override the global quoted_id to reply to a different message. Returns a unified result with per-message success/failure.",
      arguments: [
        { name: "to", description: "Recipient(s): a single JID/phone string or an array of them.", required: true },
        { name: "parts", description: "Array of content objects. Each must have a 'type' key (text, image, video, audio, document, sticker, location, contact, poll) plus the type-specific fields. Text parts accept 'mentions'. Any part accepts 'quoted_id' to override the global reply target.", required: true },
        { name: "quoted_id", description: "Optional: global message ID to reply/quote on every sent message (overridable per part).", required: false },
        { name: "delay_ms", description: "Delay in ms between individual sends. Default 500.", required: false },
      ],
      example: { to: ["33612345678", "120363000000000@g.us"], parts: [{ type: "text", text: "Hello!" }] },
      examples: [
        { description: "Text to two recipients", payload: { to: ["33612345678", "33600000000"], parts: [{ type: "text", text: "Meeting at 3pm." }] } },
        { description: "Image + text to a group", payload: { to: "120363000000000@g.us", parts: [{ type: "text", text: "Check this out" }, { type: "image", source: "/tmp/photo.jpg", caption: "Figure 1" }] } },
        { description: "Text with @mention", payload: { to: "120363000000000@g.us", parts: [{ type: "text", text: "@Alice please review", mentions: ["33600000000@s.whatsapp.net"] }] } },
        { description: "Mixed parts with per-part reply targets", payload: { to: "33612345678", parts: [{ type: "text", text: "See attached" }, { type: "image", source: "/tmp/chart.png", quoted_id: "MSG123" }, { type: "document", source: "/tmp/report.pdf", quoted_id: "MSG456" }] } },
      ],
      returns: "{ total, sent, failed, results }",
    },
    handler: async ({ to, parts, quoted_id, delay_ms }, { sock, store }) => {
      // Normalize `to` to always be an array.
      const recipients: string[] = Array.isArray(to)
        ? to.map(String)
        : [String(to)];
      if (recipients.length === 0) return errResult("At least one recipient is required.");

      const partList = parts as Record<string, unknown>[];
      if (!Array.isArray(partList) || partList.length === 0) {
        return errResult("At least one content part is required.");
      }

      const delay = delay_ms !== undefined ? Number(delay_ms) : 500;

      // Resolve the global quoted message once; parts can override with their own quoted_id.
      const quotedCache = new Map<string, AnyMsg>();
      const resolveQuoted = (qid: string | undefined): AnyMsg | undefined => {
        if (!qid) return undefined;
        if (quotedCache.has(qid)) return quotedCache.get(qid);
        const m = store.getMessage(qid);
        if (m) { quotedCache.set(qid, m as AnyMsg); return m as AnyMsg; }
        return undefined;
      };
      const globalQuoted = quoted_id ? resolveQuoted(String(quoted_id)) : undefined;

      const results: Record<string, unknown>[] = [];
      let sent = 0;
      let failed = 0;
      let sendIndex = 0;
      const totalSends = recipients.length * partList.length;

      for (const jid of recipients) {
        const toJid = phoneToJid(jid);
        for (const part of partList) {
          try {
            const content = _mapPart(part);
            // Per-part quoted_id overrides global; fallback to globalQuoted.
            const partQuoted = part.quoted_id ? resolveQuoted(String(part.quoted_id)) : globalQuoted;
            const opts: Record<string, unknown> = {};
            if (partQuoted) opts.quoted = partQuoted;
            const r: any = await sock.sendMessage(toJid, content as any, opts as any);
            results.push({
              jid: toJid,
              type: part.type,
              status: "sent",
              message_id: r?.key?.id || null,
              timestamp: r?.messageTimestamp ? Number(r.messageTimestamp) : Math.floor(Date.now() / 1000),
            });
            sent++;
          } catch (err) {
            results.push({
              jid: toJid,
              type: part.type,
              status: "failed",
              error: (err as Error).message,
            });
            failed++;
          }
          sendIndex++;
          if (delay > 0 && sendIndex < totalSends) {
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }
      return okResult({ total: totalSends, sent, failed, results });
    },
    schema: sendBatchSchema,
    docstring: `Send multiple content types to one or more recipients in a single call. Each part becomes one WhatsApp message; every part is sent to every recipient.

Parameters:
    - to (required): Recipient(s): a single JID/phone string or an array of them.
    - parts (required): Array of content objects. Each must have a 'type' key (text, image, video, audio, document, sticker, location, contact, poll) plus type-specific fields.
    - quoted_id (optional): Global message ID to reply/quote (overridable per part).
    - delay_ms (optional): Delay in ms between individual sends. Default 500.

Examples:
    - Text to two recipients:
        \`whats-proxy do send-batch '{"to":["33612345678","33600000000"],"parts":[{"type":"text","text":"Meeting at 3pm."}]}'\`
        → {"total":2,"sent":2,"failed":0,"results":[{"jid":"33612345678@s.whatsapp.net","type":"text","status":"sent","message_id":"BAT001","timestamp":1756614000},{"jid":"33600000000@s.whatsapp.net","type":"text","status":"sent","message_id":"BAT002","timestamp":1756614000}]}
    - Image + text to a group:
        \`whats-proxy do send-batch '{"to":"120363000000000@g.us","parts":[{"type":"text","text":"Check this out"},{"type":"image","source":"/tmp/photo.jpg","caption":"Figure 1"}]}'\`
        → {"total":2,"sent":2,"failed":0,"results":[{"jid":"120363000000000@g.us","type":"text","status":"sent","message_id":"BAT003","timestamp":1756614001},{"jid":"120363000000000@g.us","type":"image","status":"sent","message_id":"BAT004","timestamp":1756614001}]}
    - Mixed parts with per-part reply targets:
        \`whats-proxy do send-batch '{"to":"33612345678","parts":[{"type":"text","text":"See attached"},{"type":"image","source":"/tmp/chart.png","quoted_id":"MSG123"}]}'\`
        → {"total":2,"sent":2,"failed":0,"results":[{"jid":"33612345678@s.whatsapp.net","type":"text","status":"sent","message_id":"BAT005","timestamp":1756614002},{"jid":"33612345678@s.whatsapp.net","type":"image","status":"sent","message_id":"BAT006","timestamp":1756614002}]}`,
  },
] satisfies ActionDef[];
