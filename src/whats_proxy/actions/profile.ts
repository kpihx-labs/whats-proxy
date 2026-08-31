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
  },
] satisfies ActionDef[];
