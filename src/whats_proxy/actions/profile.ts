/**
 * whats-proxy — Profile & Privacy actions (4).
 *
 * profile-name, profile-about, profile-picture, profile-privacy.
 *
 * Faithful port of whats-mcp `profile.js`.
 */

import type { ActionDef } from "./types.ts";
import { profileNameSchema, profileAboutSchema, profilePictureSchema, profilePrivacySchema } from "./schemas.ts";
import { resolveMedia, okResult, errResult } from "../helpers.ts";

export default [
  {
    meta: {
      action: "profile-name",
      category: "profile",
      description: "Change your WhatsApp display name.",
      arguments: [
        { name: "name", description: "New display name (max 25 characters).", required: true },
      ],
      example: { name: "Ivann" },
      returns: "{ status, name }",
    },
    handler: async ({ name }, { sock }) => {
      const value = String(name || "");
      if (!value || value.length > 25) {
        return errResult("Name must be between 1 and 25 characters.");
      }
      await sock.updateProfileName(value);
      return okResult({ status: "updated", name: value });
    },
    schema: profileNameSchema,
    docstring: `Change your WhatsApp display name.

Parameters:
    - name (required): New display name (max 25 characters).

Examples:
    - Update display name:
        \`whats-proxy do profile-name '{"name":"Ivann"}'\`
        → {"status":"updated","name":"Ivann"}
    - Set a shorter name:
        \`whats-proxy do profile-name '{"name":"KπX"}'\`
        → {"status":"updated","name":"KπX"}
    - Name too long (error):
        \`whats-proxy do profile-name '{"name":"This name is way too long for WhatsApp"}'\`
        → {"meta":{"status":"error","comment":"Name must be between 1 and 25 characters.","edited":false},"data":{"error":"Name must be between 1 and 25 characters."}}`,
  },
  {
    meta: {
      action: "profile-about",
      category: "profile",
      description: "Change your WhatsApp 'About' status text.",
      arguments: [
        { name: "text", description: "New about text (max 139 characters). Empty string to clear.", required: true },
      ],
      example: { text: "Building things." },
      returns: "{ status, about }",
    },
    handler: async ({ text }, { sock }) => {
      await sock.updateProfileStatus(String(text || ""), "", 0);
      return okResult({ status: "updated", about: text });
    },
    schema: profileAboutSchema,
    docstring: `Change your WhatsApp 'About' status text.

Parameters:
    - text (required): New about text (max 139 characters). Empty string to clear.

Examples:
    - Set about text:
        \`whats-proxy do profile-about '{"text":"Building things."}'\`
        → {"status":"updated","about":"Building things."}
    - Set a longer status:
        \`whats-proxy do profile-about '{"text":"System architect | École Polytechnique X24 | Open to opportunities"}'\`
        → {"status":"updated","about":"System architect | École Polytechnique X24 | Open to opportunities"}
    - Clear about text:
        \`whats-proxy do profile-about '{"text":""}'\`
        → {"status":"updated","about":""}`,
  },
  {
    meta: {
      action: "profile-picture",
      category: "profile",
      description: "Change your WhatsApp profile picture.",
      arguments: [
        { name: "source", description: "Image source: URL, base64, or local file path. Use 'remove' to delete the picture.", required: true },
      ],
      example: { source: "/path/to/pic.jpg" },
      returns: "{ status }",
    },
    handler: async ({ source }, { sock }) => {
      if (source === "remove") {
        await sock.removeProfilePicture((sock as any).user?.id);
        return okResult({ status: "removed" });
      }
      const media = resolveMedia(String(source));
      let imgBuf: Buffer;
      if (Buffer.isBuffer(media)) {
        imgBuf = media;
      } else if (media.url) {
        const resp = await fetch(media.url);
        imgBuf = Buffer.from(await resp.arrayBuffer());
      } else {
        imgBuf = media as unknown as Buffer;
      }
      await sock.updateProfilePicture((sock as any).user?.id, imgBuf);
      return okResult({ status: "updated" });
    },
    schema: profilePictureSchema,
    docstring: `Change your WhatsApp profile picture.

Parameters:
    - source (required): Image source: URL, base64, or local file path. Use 'remove' to delete.

Examples:
    - Set profile picture from local file:
        \`whats-proxy do profile-picture '{"source":"/home/user/Pictures/avatar.jpg"}'\`
        → {"status":"updated"}
    - Set from URL:
        \`whats-proxy do profile-picture '{"source":"https://example.com/photo.png"}'\`
        → {"status":"updated"}
    - Remove profile picture:
        \`whats-proxy do profile-picture '{"source":"remove"}'\`
        → {"status":"removed"}`,
  },
  {
    meta: {
      action: "profile-privacy",
      category: "profile",
      description:
        "Get or update WhatsApp privacy settings. Use action='get' to retrieve current settings. Use action='set' with a setting name and value to update.",
      arguments: [
        { name: "action", description: "Action: 'get' to retrieve all privacy settings, 'set' to update one.", required: true },
        { name: "setting", description: "Privacy setting: last_seen | online | profile_picture | about | read_receipts | groups_add | default_disappearing.", required: false },
        { name: "value", description: "New value: all | contacts | contact_blacklist | none | match_last_seen.", required: false },
      ],
      example: { action: "get" },
      returns: "{ privacy } | { status, setting, value }",
    },
    handler: async ({ action, setting, value }, { sock }) => {
      if (action === "get") {
        const settings = await sock.fetchPrivacySettings(true);
        return okResult({ privacy: settings });
      }

      if (action === "set") {
        if (!setting || !value) {
          return errResult("Both 'setting' and 'value' are required for 'set' action.");
        }

        const s = String(setting);
        const v = String(value);
        const apiMap: Record<string, () => Promise<unknown>> = {
          last_seen: () => sock.updateLastSeenPrivacy(v as "all" | "contacts" | "contact_blacklist" | "none"),
          online: () => sock.updateOnlinePrivacy(v as "all" | "match_last_seen"),
          profile_picture: () => sock.updateProfilePicturePrivacy(v as "all" | "contacts" | "contact_blacklist" | "none"),
          about: () => sock.updateStatusPrivacy(v as "all" | "contacts" | "contact_blacklist" | "none"),
          read_receipts: () => sock.updateReadReceiptsPrivacy(v as "all" | "none"),
          groups_add: () => sock.updateGroupsAddPrivacy(v as "all" | "contacts" | "contact_blacklist"),
          default_disappearing: () => sock.updateDefaultDisappearingMode(
            v === "all" ? 0 : v === "contacts" ? 86400 : 604800,
          ),
        };

        const fn = apiMap[s];
        if (!fn) return errResult(`Unknown setting: ${setting}.`);

        await fn();
        return okResult({ status: "updated", setting: s, value: v });
      }

      return errResult(`Unknown action: ${action}`);
    },
    schema: profilePrivacySchema,
    docstring: `Get or update WhatsApp privacy settings.

Parameters:
    - action (required): 'get' to retrieve all privacy settings, 'set' to update one.
    - setting (optional): Privacy setting: last_seen | online | profile_picture | about | read_receipts | groups_add | default_disappearing.
    - value (optional): New value: all | contacts | contact_blacklist | none | match_last_seen.

Examples:
    - Get all privacy settings:
        \`whats-proxy do profile-privacy '{"action":"get"}'\`
        → {"privacy":{"last_seen":"contacts","online":"match_last_seen","profile_picture":"contacts","about":"contacts","read_receipts":"all","groups_add":"contacts"}}
    - Set last_seen to contacts only:
        \`whats-proxy do profile-privacy '{"action":"set","setting":"last_seen","value":"contacts"}'\`
        → {"status":"updated","setting":"last_seen","value":"contacts"}
    - Disable read receipts:
        \`whats-proxy do profile-privacy '{"action":"set","setting":"read_receipts","value":"none"}'\`
        → {"status":"updated","setting":"read_receipts","value":"none"}`,
  },
] satisfies ActionDef[];
