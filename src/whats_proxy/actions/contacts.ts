/**
 * whats-proxy — Contact actions (6).
 *
 * contact-check, contact-info, contact-picture, contact-block,
 * contact-business, contact-list.
 *
 * Faithful port of whats-mcp `contacts.js`.
 */

import type { ActionDef } from "./types.ts";
import { contactCheckSchema, contactInfoSchema, contactPictureSchema, contactBlockSchema, contactBusinessSchema, contactListSchema } from "./schemas.ts";
import { phoneToJid, jidToPhone, isGroupJid, okResult, errResult } from "../helpers.ts";

export default [
  {
    meta: {
      action: "contact-check",
      category: "contacts",
      description:
        "Check if one or more phone numbers are registered on WhatsApp. Returns the JID for each number that is on WhatsApp.",
      arguments: [
        { name: "phones", description: "Array of phone numbers to check (e.g. ['33612345678', '+1555000123']).", required: true },
      ],
      example: { phones: ["33612345678"] },
      returns: "{ total, on_whatsapp, results }",
    },
    handler: async ({ phones }, { sock }) => {
      const list = Array.isArray(phones) ? phones.map(String) : [];
      if (list.length === 0) {
        return errResult("At least one phone number is required.");
      }
      const ids = list.map((p) => phoneToJid(p));
      const result = (await sock.onWhatsApp(...ids)) || [];
      const formatted = result.map((r: any) => ({
        phone: jidToPhone(r.jid),
        jid: r.jid,
        exists: r.exists,
      }));
      return okResult({
        total: list.length,
        on_whatsapp: formatted.filter((r: any) => r.exists).length,
        results: formatted,
      });
    },
    schema: contactCheckSchema,
    docstring: `Check if one or more phone numbers are registered on WhatsApp.

Parameters:
    - phones (required): Array of phone numbers to check.

Examples:
    - Check a single number:
        \`whats-proxy do contact-check '{"phones":["33612345678"]}'\`
        → {"total":1,"on_whatsapp":1,"results":[{"phone":"33612345678","jid":"33612345678@s.whatsapp.net","exists":true}]}
    - Check multiple numbers:
        \`whats-proxy do contact-check '{"phones":["33612345678","33699999999"]}'\`
        → {"total":2,"on_whatsapp":1,"results":[{"phone":"33612345678","jid":"33612345678@s.whatsapp.net","exists":true},{"phone":"33699999999","jid":"33699999999@s.whatsapp.net","exists":false}]}
    - Check with international format:
        \`whats-proxy do contact-check '{"phones":["+15550001234"]}'\`
        → {"total":1,"on_whatsapp":0,"results":[{"phone":"15550001234","jid":"15550001234@s.whatsapp.net","exists":false}]}`,
  },
  {
    meta: {
      action: "contact-info",
      category: "contacts",
      description:
        "Get info about a contact: name, about/status text, and profile picture URL. Combines data from the local store and live API calls.",
      arguments: [
        { name: "jid", description: "Contact JID or phone number.", required: true },
      ],
      example: { jid: "33612345678" },
      returns: "{ jid, name, about, profile_picture_url }",
    },
    handler: async ({ jid }, { sock, store }) => {
      const contactJid = phoneToJid(String(jid));
      const info: Record<string, unknown> = { jid: contactJid };

      const storeContact = store.getContact(contactJid);
      if (storeContact) {
        info.name = storeContact.name || storeContact.notify || storeContact.verifiedName || null;
        info.short_name = storeContact.short || null;
      }

      try {
        const status: any = await sock.fetchStatus(contactJid);
        info.about = status?.status || null;
        info.about_set_at = status?.setAt ? Number(status.setAt) : null;
      } catch {
        info.about = null;
      }

      try {
        info.profile_picture_url = await sock.profilePictureUrl(contactJid, "image");
      } catch {
        info.profile_picture_url = null;
      }

      return okResult(info);
    },
    schema: contactInfoSchema,
    docstring: `Get info about a contact: name, about/status text, and profile picture URL.

Parameters:
    - jid (required): Contact JID or phone number.

Examples:
    - Get contact info:
        \`whats-proxy do contact-info '{"jid":"33612345678"}'\`
        → {"jid":"33612345678@s.whatsapp.net","name":"Alice","short_name":"Alice","about":"Building things.","profile_picture_url":"https://pps.whatsapp.net/v/t61..."}
    - Get info by phone number:
        \`whats-proxy do contact-info '{"jid":"33600000000"}'\`
        → {"jid":"33600000000@s.whatsapp.net","name":"Bob","about":null,"profile_picture_url":null}
    - Get info for unknown contact:
        \`whats-proxy do contact-info '{"jid":"33611111111"}'\`
        → {"jid":"33611111111@s.whatsapp.net","name":null,"about":null,"profile_picture_url":null}`,
  },
  {
    meta: {
      action: "contact-picture",
      category: "contacts",
      description: "Get the profile picture URL for any JID (contact, group, or your own).",
      arguments: [
        { name: "jid", description: "JID or phone number. Use 'me' for your own picture.", required: true },
        { name: "type", description: "Resolution: 'image' for full size, 'preview' for thumbnail. Default 'image'.", required: false },
      ],
      example: { jid: "me", type: "image" },
      returns: "{ jid, profile_picture_url }",
    },
    handler: async ({ jid, type }, { sock }) => {
      let targetJid: string;
      if (jid === "me") {
        const user: any = (sock as any).user;
        targetJid = user?.id;
        if (!targetJid) return errResult("Cannot determine own JID. Are you connected?");
      } else {
        targetJid = phoneToJid(String(jid));
      }
      try {
        const url = await sock.profilePictureUrl(targetJid, (type as any) || "image");
        return okResult({ jid: targetJid, profile_picture_url: url });
      } catch (err) {
        if ((err as Error).message?.includes("404") || (err as Error).message?.includes("not-authorized")) {
          return okResult({ jid: targetJid, profile_picture_url: null, note: "No profile picture or not authorized." });
        }
        throw err;
      }
    },
    schema: contactPictureSchema,
    docstring: `Get the profile picture URL for any JID (contact, group, or your own).

Parameters:
    - jid (required): JID or phone number. Use 'me' for your own picture.
    - type (optional): Resolution: 'image' for full size, 'preview' for thumbnail. Default 'image'.

Examples:
    - Get your own profile picture:
        \`whats-proxy do contact-picture '{"jid":"me"}'\`
        → {"jid":"33612345678@s.whatsapp.net","profile_picture_url":"https://pps.whatsapp.net/v/t61..."}
    - Get a contact's picture:
        \`whats-proxy do contact-picture '{"jid":"33600000000","type":"preview"}'\`
        → {"jid":"33600000000@s.whatsapp.net","profile_picture_url":"https://pps.whatsapp.net/v/t61...preview"}
    - Get a group picture:
        \`whats-proxy do contact-picture '{"jid":"120363000000000@g.us"}'\`
        → {"jid":"120363000000000@g.us","profile_picture_url":"https://pps.whatsapp.net/v/t61..."}`,
  },
  {
    meta: {
      action: "contact-block",
      category: "contacts",
      description: "Block, unblock a contact, or list blocked contacts.",
      arguments: [
        { name: "action", description: "Action to perform: block | unblock | list.", required: true },
        { name: "jid", description: "Contact JID or phone number (required for block/unblock).", required: false },
      ],
      example: { action: "block", jid: "33612345678" },
      returns: "{ status, jid } | { count, blocked }",
    },
    handler: async ({ action, jid }, { sock }) => {
      if (action === "list") {
        const blocked = await sock.fetchBlocklist();
        return okResult({
          count: blocked.length,
          blocked: blocked.map((b: string | undefined) => ({ jid: b, phone: b ? jidToPhone(b) : null })),
        });
      }
      if (!jid) return errResult(`JID is required for ${action} action.`);
      const contactJid = phoneToJid(String(jid));
      if (action === "block") {
        await sock.updateBlockStatus(contactJid, "block");
        return okResult({ status: "blocked", jid: contactJid });
      }
      if (action === "unblock") {
        await sock.updateBlockStatus(contactJid, "unblock");
        return okResult({ status: "unblocked", jid: contactJid });
      }
      return errResult(`Unknown action: ${action}`);
    },
    schema: contactBlockSchema,
    docstring: `Block, unblock a contact, or list blocked contacts.

Parameters:
    - action (required): Action to perform: block | unblock | list.
    - jid (optional): Contact JID or phone number (required for block/unblock).

Examples:
    - Block a contact:
        \`whats-proxy do contact-block '{"action":"block","jid":"33612345678"}'\`
        → {"status":"blocked","jid":"33612345678@s.whatsapp.net"}
    - List blocked contacts:
        \`whats-proxy do contact-block '{"action":"list"}'\`
        → {"count":3,"blocked":[{"jid":"33611111111@s.whatsapp.net","phone":"33611111111"},{"jid":"33622222222@s.whatsapp.net","phone":"33622222222"}]}
    - Unblock a contact:
        \`whats-proxy do contact-block '{"action":"unblock","jid":"33612345678"}'\`
        → {"status":"unblocked","jid":"33612345678@s.whatsapp.net"}`,
  },
  {
    meta: {
      action: "contact-business",
      category: "contacts",
      description:
        "Get the WhatsApp Business profile of a contact. Returns business info: description, category, website, email, etc.",
      arguments: [
        { name: "jid", description: "Business contact JID or phone number.", required: true },
      ],
      example: { jid: "33612345678" },
      returns: "{ jid, business_profile }",
    },
    handler: async ({ jid }, { sock }) => {
      const contactJid = phoneToJid(String(jid));
      try {
        const profile: any = await sock.getBusinessProfile(contactJid);
        return okResult({
          jid: contactJid,
          business_profile: profile || null,
        });
      } catch {
        return okResult({
          jid: contactJid,
          business_profile: null,
          note: "Could not retrieve business profile. Contact may not be a business account.",
        });
      }
    },
    schema: contactBusinessSchema,
    docstring: `Get the WhatsApp Business profile of a contact. Returns business info: description, category, website, email, etc.

Parameters:
    - jid (required): Business contact JID or phone number.

Examples:
    - Get business profile:
        \`whats-proxy do contact-business '{"jid":"33612345678"}'\`
        → {"jid":"33612345678@s.whatsapp.net","business_profile":{"description":"Premium coffee roasters","category":"Food & Beverage","website":"https://example.com","email":"hello@example.com"}}
    - Non-business contact:
        \`whats-proxy do contact-business '{"jid":"33600000000"}'\`
        → {"jid":"33600000000@s.whatsapp.net","business_profile":null,"note":"Could not retrieve business profile. Contact may not be a business account."}
    - Business with full details:
        \`whats-proxy do contact-business '{"jid":"33622222222"}'\`
        → {"jid":"33622222222@s.whatsapp.net","business_profile":{"description":"Tech solutions","category":"Technology","website":"https://tech.example.com","email":"support@tech.example.com","address":"123 Main St"}}`,
  },
  {
    meta: {
      action: "contact-list",
      category: "contacts",
      description:
        "List contacts from the local store with optional filtering by name, tag, or type. Returns contact info including custom tags if any are assigned.",
      arguments: [
        { name: "limit", description: "Max contacts to return (default 100, max 1000).", required: false },
        { name: "offset", description: "Offset for pagination (default 0).", required: false },
        { name: "name", description: "Filter by name (case-insensitive substring match).", required: false },
        { name: "tag", description: "Filter to contacts with this custom tag.", required: false },
        { name: "has_tags", description: "If true, only contacts with tags; if false, only without tags.", required: false },
        { name: "exclude_groups", description: "Exclude group JIDs from results (default true).", required: false },
      ],
      example: { limit: 100, tag: "x24" },
      returns: "{ total, offset, count, contacts }",
    },
    handler: async ({ limit, offset, name, tag, has_tags, exclude_groups }, { store }) => {
      let contacts = store.listContacts({ name: name as string, tag: tag as string, has_tags: has_tags as boolean });

      if (exclude_groups !== false) {
        contacts = contacts.filter((c: any) => !isGroupJid(c.id));
      }

      const total = contacts.length;
      const off = Number(offset || 0);
      const lim = Math.min(Number(limit) || 100, 1000);
      const page = contacts.slice(off, off + lim);

      return okResult({
        total,
        offset: off,
        count: page.length,
        contacts: page.map((c: any) => ({
          jid: c.id,
          phone: jidToPhone(c.id),
          name: store.resolveContactName(c.id),
          short_name: c.short || null,
          tags: store.getContactTags(c.id),
        })),
      });
    },
    schema: contactListSchema,
    docstring: `List contacts from the local store with optional filtering by name, tag, or type.

Parameters:
    - limit (optional): Max contacts to return (default 100, max 1000).
    - offset (optional): Offset for pagination (default 0).
    - name (optional): Filter by name (case-insensitive substring match).
    - tag (optional): Filter to contacts with this custom tag.
    - has_tags (optional): If true, only contacts with tags; if false, only without tags.
    - exclude_groups (optional): Exclude group JIDs from results (default true).

Examples:
    - List all contacts:
        \`whats-proxy do contact-list '{}'\`
        → {"total":250,"offset":0,"count":100,"contacts":[{"jid":"33612345678@s.whatsapp.net","phone":"33612345678","name":"Alice","tags":["x24"]},{"jid":"33600000000@s.whatsapp.net","phone":"33600000000","name":"Bob","tags":[]}]}
    - Filter by tag:
        \`whats-proxy do contact-list '{"tag":"important","limit":50}'\`
        → {"total":12,"offset":0,"count":12,"contacts":[{"jid":"33612345678@s.whatsapp.net","phone":"33612345678","name":"Alice","tags":["important","x24"]}]}
    - Filter by name:
        \`whats-proxy do contact-list '{"name":"alice"}'\`
        → {"total":2,"offset":0,"count":2,"contacts":[{"jid":"33612345678@s.whatsapp.net","phone":"33612345678","name":"Alice"},{"jid":"33699999999@s.whatsapp.net","phone":"33699999999","name":"Alice B."}]}`,
  },
] satisfies ActionDef[];
