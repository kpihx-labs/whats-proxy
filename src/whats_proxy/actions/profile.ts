/**
 * whats-proxy — Profile & Privacy actions (4).
 *
 * profile-name, profile-about, profile-picture, profile-privacy.
 * All use unified { action: "get"|"edit" } pattern.
 */

import type { ActionDef } from "./types.ts";
import { requireApproval } from "../decorators.ts";
import { profileNameSchema, profileAboutSchema, profilePictureSchema, profilePrivacySchema } from "./schemas.ts";
import { resolveMedia, okResult, errResult } from "../helpers.ts";

export default [
  {
    meta: {
      action: "profile-name",
      category: "profile",
      description: "Get or change your WhatsApp display name.",
      arguments: [
        { name: "action", description: "'get' to read current name, 'edit' to change it.", required: true },
        { name: "name", description: "New display name (max 25 characters). Required for 'edit'.", required: false },
      ],
      example: { action: "get" },
      returns: "{ name } | { status, name }",
    },
    handler: async ({ action, name }, { sock }) => {
      if (action === "get") {
        const currentName = (sock as any).user?.name || null;
        return okResult({ name: currentName });
      }
      if (action === "edit") {
        const value = String(name || "");
        if (!value || value.length > 25) {
          return errResult("Name must be between 1 and 25 characters.");
        }
        await sock.updateProfileName(value);
        return okResult({ status: "updated", name: value });
      }
      return errResult(`Unknown action: ${action}. Use 'get' or 'edit'.`);
    },
    schema: profileNameSchema,
    docstring: `Get or change your WhatsApp display name.

Parameters:
    - action (required): 'get' to read current name, 'edit' to change it.
    - name (optional, edit only): New display name (max 25 characters).

Examples:
    - Read current name:
        \`whats-proxy do profile-name '{"action":"get"}'\`
        → {"name":"KπX"}
    - Change name:
        \`whats-proxy do profile-name '{"action":"edit","name":"Ivann"}'\`
        → {"status":"updated","name":"Ivann"}`,
  },
  {
    meta: {
      action: "profile-about",
      category: "profile",
      description: "Get or change your WhatsApp 'About' status text.",
      arguments: [
        { name: "action", description: "'get' to read current about, 'edit' to change it.", required: true },
        { name: "text", description: "New about text (max 139 characters). Required for 'edit'. Empty string to clear.", required: false },
      ],
      example: { action: "get" },
      returns: "{ about, setAt } | { status, about }",
    },
    handler: requireApproval("default")(async ({ action, text }, { sock }) => {
      if (action === "get") {
        const jid = (sock as any).user?.id;
        const result = await (sock as any).fetchStatus(jid);
        // fetchStatus returns a USyncQuery list array, not a single object
        const entry = Array.isArray(result) ? result[0] : result;
        return okResult({ about: entry?.about || entry?.status || "", setAt: entry?.setAt || null });
      }
      if (action === "edit") {
        await sock.updateProfileStatus(String(text ?? ""), "", 0);
        return okResult({ status: "updated", about: text });
      }
      return errResult(`Unknown action: ${action}. Use 'get' or 'edit'.`);
    }),
    schema: profileAboutSchema,
    docstring: `Get or change your WhatsApp 'About' status text. ⚠️ EDIT is broken on linked/companion devices — updateProfileStatus GraphQL query does not take effect (Baileys fork bug). GET works correctly.

Parameters:
    - action (required): 'get' to read current about, 'edit' to change it.
    - text (optional, edit only): New about text (max 139 characters). Empty string to clear.

Examples:
    - Read current about:
        \`whats-proxy do profile-about '{"action":"get"}'\`
        → {"about":"Building things.","setAt":1788200000}
    - Set about text:
        \`whats-proxy do profile-about '{"action":"edit","text":"System architect | Polytechnique X24"}'\`
        → {"status":"updated","about":"System architect | Polytechnique X24"}
    - Clear about:
        \`whats-proxy do profile-about '{"action":"edit","text":""}'\`
        → {"status":"updated","about":""}`,
  },
  {
    meta: {
      action: "profile-picture",
      category: "profile",
      description: "Get, change, or remove your WhatsApp profile picture.",
      arguments: [
        { name: "action", description: "'get' to read picture URL, 'edit' to change, 'remove' to delete.", required: true },
        { name: "source", description: "Image source: URL, base64, or local file path. Required for 'edit'.", required: false },
      ],
      example: { action: "get" },
      returns: "{ url } | { status }",
    },
    handler: requireApproval("default")(async ({ action, source }, { sock }) => {
      const jid = (sock as any).user?.id;
      if (action === "get") {
        try {
          const url = await sock.profilePictureUrl(jid, "image");
          return okResult({ url });
        } catch {
          return okResult({ url: null });
        }
      }
      if (action === "remove") {
        await sock.removeProfilePicture(jid);
        return okResult({ status: "removed" });
      }
      if (action === "edit") {
        if (!source) return errResult("'source' is required for 'edit' action.");
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
        await sock.updateProfilePicture(jid, imgBuf);
        return okResult({ status: "updated" });
      }
      return errResult(`Unknown action: ${action}. Use 'get', 'edit', or 'remove'.`);
    }),
    schema: profilePictureSchema,
    docstring: `Get, change, or remove your WhatsApp profile picture.

Parameters:
    - action (required): 'get' to read picture URL, 'edit' to change, 'remove' to delete.
    - source (optional, edit only): Image source: URL, base64, or local file path.

Examples:
    - Read current picture URL:
        \`whats-proxy do profile-picture '{"action":"get"}'\`
        → {"url":"https://pps.whatsapp.net/..."}
    - Set from local file:
        \`whats-proxy do profile-picture '{"action":"edit","source":"/path/to/pic.jpg"}'\`
        → {"status":"updated"}
    - Set from URL:
        \`whats-proxy do profile-picture '{"action":"edit","source":"https://example.com/photo.png"}'\`
        → {"status":"updated"}
    - Remove picture:
        \`whats-proxy do profile-picture '{"action":"remove"}'\`
        → {"status":"removed"}`,
  },
  {
    meta: {
      action: "profile-privacy",
      category: "profile",
      description:
        "Get or update WhatsApp privacy settings. Use action='get' to retrieve current settings. Use action='set' with a setting name and value to update.",
      arguments: [
        { name: "action", description: "'get' to retrieve all privacy settings, 'set' to update one.", required: true },
        { name: "setting", description: "Privacy setting: last_seen | online | profile_picture | about | read_receipts (all exposes one-to-one read receipts; none hides them) | groups_add | default_disappearing.", required: false },
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

read_receipts controls one-to-one read receipt visibility: all sends and receives them; none hides them. Group chat receipts are not controlled by this setting.

Parameters:
    - action (required): 'get' to retrieve all privacy settings, 'set' to update one.
    - setting (optional, set only): last_seen | online | profile_picture | about | read_receipts (all exposes one-to-one read receipts; none hides them) | groups_add | default_disappearing.
    - value (optional, set only): all | contacts | contact_blacklist | none | match_last_seen.

Examples:
    - Get all privacy settings:
        \`whats-proxy do profile-privacy '{"action":"get"}'\`
        → {"privacy":{"last_seen":"contacts","online":"match_last_seen",...}}
    - Set last_seen to contacts only:
        \`whats-proxy do profile-privacy '{"action":"set","setting":"last_seen","value":"contacts"}'\`
        → {"status":"updated","setting":"last_seen","value":"contacts"}`,
  },
] satisfies ActionDef[];
