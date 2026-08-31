/**
 * whats-proxy — Channel (Newsletter) actions (5).
 *
 * channel-create, channel-info, channel-manage, channel-update, channel-delete.
 *
 * Faithful port of whats-mcp `channels.js`.
 */

import type { ActionDef } from "./types.ts";
import { requireApproval, requirePreflight } from "../decorators.ts";
import { channelCreateSchema, channelInfoSchema, channelManageSchema, channelUpdateSchema, channelDeleteSchema } from "./schemas.ts";
import { newsletterJid, resolveMedia, okResult, errResult } from "../helpers.ts";

function _fmtChannel(meta: any) {
  return {
    jid: meta.id,
    name: meta.name || meta.subject || null,
    description: meta.description || meta.desc || null,
    subscriber_count: meta.subscribers || meta.subscriberCount || null,
    creation_time: meta.creation ? Number(meta.creation) : null,
    picture_url: meta.picture || meta.pictureUrl || null,
    invite_link: meta.inviteLink || null,
    state: meta.state || null,
    verification: meta.verification || null,
    mute: meta.mute || null,
  };
}

export default [
  {
    meta: {
      action: "channel-create",
      category: "channels",
      description:
        "Create a new WhatsApp Channel (Newsletter). Returns the channel metadata including JID.",
      arguments: [
        { name: "name", description: "Channel name.", required: true },
        { name: "description", description: "Optional channel description.", required: false },
        { name: "picture", description: "Optional profile picture: URL, base64, or file path.", required: false },
      ],
      example: { name: "My Channel", description: "Updates" },
      returns: "{ status, channel }",
    },
    handler: requireApproval("default")(async ({ name, description, picture }, { sock }) => {
      const opts: Record<string, unknown> = { name: String(name) };
      if (description) opts.description = description;
      if (picture) {
        const media = resolveMedia(String(picture));
        if (Buffer.isBuffer(media)) {
          opts.picture = media;
        } else if (media.url) {
          const resp = await fetch(media.url);
          opts.picture = Buffer.from(await resp.arrayBuffer());
        }
      }
      const result: any = await (sock as any).newsletterCreate(String(name), opts);
      return okResult({
        status: "created",
        channel: _fmtChannel(result),
      });
    }),
    schema: channelCreateSchema,
    docstring: `Create a new WhatsApp Channel (Newsletter). Returns the channel metadata including JID.

Parameters:
    - name (required): Channel name.
    - description (optional): Channel description.
    - picture (optional): Profile picture: URL, base64, or file path.

Examples:
    - Create a channel:
        \`whats-proxy do channel-create '{"name":"My Channel","description":"Updates"}'\`
        → {"status":"created","channel":{"jid":"120363000000000@newsletter","name":"My Channel","description":"Updates","subscriber_count":0}}
    - Create with picture:
        \`whats-proxy do channel-create '{"name":"Tech News","description":"Latest in tech","picture":"/home/user/logo.png"}'\`
        → {"status":"created","channel":{"jid":"120363000000001@newsletter","name":"Tech News","description":"Latest in tech","subscriber_count":0}}
    - Create minimal channel:
        \`whats-proxy do channel-create '{"name":"Quick Updates"}'\`
        → {"status":"created","channel":{"jid":"120363000000002@newsletter","name":"Quick Updates","description":null,"subscriber_count":0}}`,
  },
  {
    meta: {
      action: "channel-info",
      category: "channels",
      description:
        "Get metadata for a WhatsApp Channel (Newsletter). You can fetch by JID or invite link.",
      arguments: [
        { name: "jid", description: "Channel JID (e.g. 120363xxx@newsletter) or invite link.", required: true },
      ],
      example: { jid: "120363000000000@newsletter" },
      returns: "{ channel }",
    },
    handler: async ({ jid }, { sock }) => {
      const raw = String(jid);
      let meta: any;
      if (raw.startsWith("https://") || raw.startsWith("http://")) {
        const code = raw.split("/").pop();
        meta = await (sock as any).newsletterMetadata("invite", code);
      } else {
        const channelJid = newsletterJid(raw);
        meta = await (sock as any).newsletterMetadata("jid", channelJid);
      }
      return okResult({ channel: _fmtChannel(meta) });
    },
    schema: channelInfoSchema,
    docstring: `Get metadata for a WhatsApp Channel (Newsletter). You can fetch by JID or invite link.

Parameters:
    - jid (required): Channel JID (e.g. 120363xxx@newsletter) or invite link.

Examples:
    - Get channel info by JID:
        \`whats-proxy do channel-info '{"jid":"120363000000000@newsletter"}'\`
        → {"channel":{"jid":"120363000000000@newsletter","name":"Tech News","description":"Latest in tech","subscriber_count":1500,"state":"ACTIVE"}}
    - Get channel by invite link:
        \`whats-proxy do channel-info '{"jid":"https://whatsapp.com/channel/120363000000000"}'\`
        → {"channel":{"jid":"120363000000000@newsletter","name":"Tech News","subscriber_count":1500}}
    - Get channel with no description:
        \`whats-proxy do channel-info '{"jid":"120363000000001@newsletter"}'\`
        → {"channel":{"jid":"120363000000001@newsletter","name":"Quick Updates","description":null,"subscriber_count":42}}`,
  },
  {
    meta: {
      action: "channel-manage",
      category: "channels",
      description: "Follow (subscribe), unfollow, mute, or unmute a WhatsApp Channel.",
      arguments: [
        { name: "jid", description: "Channel JID.", required: true },
        { name: "action", description: "Action to perform: follow | unfollow | mute | unmute.", required: true },
      ],
      example: { jid: "120363000000000@newsletter", action: "follow" },
      returns: "{ status, jid }",
    },
    handler: requireApproval("default")(async ({ jid, action }, { sock }) => {
      const channelJid = newsletterJid(String(jid));

      if (action === "follow") {
        await (sock as any).newsletterFollow(channelJid);
        return okResult({ status: "followed", jid: channelJid });
      }
      if (action === "unfollow") {
        await (sock as any).newsletterUnfollow(channelJid);
        return okResult({ status: "unfollowed", jid: channelJid });
      }
      if (action === "mute") {
        await (sock as any).newsletterMute(channelJid);
        return okResult({ status: "muted", jid: channelJid });
      }
      if (action === "unmute") {
        await (sock as any).newsletterUnmute(channelJid);
        return okResult({ status: "unmuted", jid: channelJid });
      }
      return errResult(`Unknown action: ${action}`);
    }),
    schema: channelManageSchema,
    docstring: `Follow (subscribe), unfollow, mute, or unmute a WhatsApp Channel.

Parameters:
    - jid (required): Channel JID.
    - action (required): Action to perform: follow | unfollow | mute | unmute.

Examples:
    - Follow a channel:
        \`whats-proxy do channel-manage '{"jid":"120363000000000@newsletter","action":"follow"}'\`
        → {"status":"followed","jid":"120363000000000@newsletter"}
    - Mute a channel:
        \`whats-proxy do channel-manage '{"jid":"120363000000000@newsletter","action":"mute"}'\`
        → {"status":"muted","jid":"120363000000000@newsletter"}
    - Unfollow a channel:
        \`whats-proxy do channel-manage '{"jid":"120363000000000@newsletter","action":"unfollow"}'\`
        → {"status":"unfollowed","jid":"120363000000000@newsletter"}`,
  },
  {
    meta: {
      action: "channel-update",
      category: "channels",
      description: "Update a channel's name, description, or picture.",
      arguments: [
        { name: "jid", description: "Channel JID.", required: true },
        { name: "name", description: "New channel name.", required: false },
        { name: "description", description: "New channel description.", required: false },
        { name: "picture", description: "New picture: URL, base64, or file path. Use 'remove' to delete.", required: false },
      ],
      example: { jid: "120363000000000@newsletter", name: "New Name" },
      returns: "{ status, jid, updated }",
    },
    handler: requireApproval("default")(async ({ jid, name, description, picture }, { sock }) => {
      const channelJid = newsletterJid(String(jid));
      const updates: string[] = [];

      if (name) {
        await (sock as any).newsletterUpdateName(channelJid, String(name));
        updates.push("name");
      }
      if (description !== undefined) {
        await (sock as any).newsletterUpdateDescription(channelJid, String(description));
        updates.push("description");
      }
      if (picture) {
        if (picture === "remove") {
          await (sock as any).newsletterRemovePicture(channelJid);
          updates.push("picture (removed)");
        } else {
          const media = resolveMedia(String(picture));
          let imgBuf: Buffer;
          if (Buffer.isBuffer(media)) {
            imgBuf = media;
          } else if (media.url) {
            const resp = await fetch(media.url);
            imgBuf = Buffer.from(await resp.arrayBuffer());
          } else {
            imgBuf = media as unknown as Buffer;
          }
          await (sock as any).newsletterUpdatePicture(channelJid, imgBuf);
          updates.push("picture");
        }
      }

      if (updates.length === 0) {
        return errResult("No updates provided. Specify name, description, or picture.");
      }
      return okResult({ status: "updated", jid: channelJid, updated: updates });
    }),
    schema: channelUpdateSchema,
    docstring: `Update a channel's name, description, or picture.

Parameters:
    - jid (required): Channel JID.
    - name (optional): New channel name.
    - description (optional): New channel description.
    - picture (optional): New picture: URL, base64, or file path. Use 'remove' to delete.

Examples:
    - Rename a channel:
        \`whats-proxy do channel-update '{"jid":"120363000000000@newsletter","name":"Tech Digest"}'\`
        → {"status":"updated","jid":"120363000000000@newsletter","updated":["name"]}
    - Update description:
        \`whats-proxy do channel-update '{"jid":"120363000000000@newsletter","description":"Daily tech news and insights"}'\`
        → {"status":"updated","jid":"120363000000000@newsletter","updated":["description"]}
    - Remove channel picture:
        \`whats-proxy do channel-update '{"jid":"120363000000000@newsletter","picture":"remove"}'\`
        → {"status":"updated","jid":"120363000000000@newsletter","updated":["picture (removed)"]}`,
  },
  {
    meta: {
      action: "channel-delete",
      category: "channels",
      description: "Delete a WhatsApp Channel that you own. This action is irreversible.",
      arguments: [
        { name: "jid", description: "Channel JID to delete.", required: true },
      ],
      example: { jid: "120363000000000@newsletter" },
      returns: "{ status, jid }",
    },
    handler: requireApproval("default")(
      requirePreflight(
        async (args, ctx) => {
          try {
            await (ctx as any).sock.newsletterMetadata("jid", String(args.jid));
          } catch {
            throw new Error(`Channel ${String(args.jid)} could not be read before destructive review.`);
          }
        },
        ["jid"],
      )(async ({ jid }, { sock }) => {
        const channelJid = newsletterJid(String(jid));
        await (sock as any).newsletterDelete(channelJid);
        return okResult({ status: "deleted", jid: channelJid });
      }),
    ),
    schema: channelDeleteSchema,
    docstring: `Delete a WhatsApp Channel that you own. This action is irreversible.

Parameters:
    - jid (required): Channel JID to delete.

Examples:
    - Delete a channel:
        \`whats-proxy do channel-delete '{"jid":"120363000000000@newsletter"}'\`
        → {"status":"deleted","jid":"120363000000000@newsletter"}
    - Delete another channel:
        \`whats-proxy do channel-delete '{"jid":"120363000000001@newsletter"}'\`
        → {"status":"deleted","jid":"120363000000001@newsletter"}
    - Delete with bare ID:
        \`whats-proxy do channel-delete '{"jid":"120363000000002"}'\`
        → {"status":"deleted","jid":"120363000000002@newsletter"}`,
  },
] satisfies ActionDef[];
