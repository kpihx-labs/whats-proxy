/**
 * whats-proxy — Contact tag actions (1).
 *
 * contact-tags (manage_contact_tags).
 *
 * Faithful port of whats-mcp `tags.js`.
 */

import type { ActionDef } from "./types.ts";
import { contactTagsSchema } from "./schemas.ts";
import { phoneToJid, jidToPhone, okResult, errResult } from "../helpers.ts";

export default [
  {
    meta: {
      action: "contact-tags",
      category: "contacts",
      description:
        "Manage custom contact tags/labels for classification. Actions: set (replace all tags), add (append new tags), remove (remove specific tags), get (view contact's tags), list (all tags with counts), list_by_tag (contacts with a specific tag).",
      arguments: [
        { name: "action", description: "Action to perform: set | add | remove | get | list | list_by_tag.", required: true },
        { name: "jid", description: "Contact JID or phone number (required for set/add/remove/get).", required: false },
        { name: "tags", description: "Tags to set/add/remove.", required: false },
        { name: "tag", description: "Tag name for list_by_tag action.", required: false },
      ],
      example: { action: "set", jid: "33612345678", tags: ["x24", "important"] },
      returns: "{ jid, tags } | { tags, counts } | { tag, count, contacts }",
    },
    handler: async ({ action, jid, tags, tag }, { store }) => {
      const tagsList = Array.isArray(tags) ? tags.map(String) : [];
      switch (action) {
        case "set": {
          if (!jid) return errResult("jid is required for 'set' action.");
          if (tagsList.length === 0) return errResult("tags array is required for 'set' action.");
          const contactJid = phoneToJid(String(jid));
          store.setContactTags(contactJid, tagsList);
          return okResult({ jid: contactJid, tags: store.getContactTags(contactJid) });
        }
        case "add": {
          if (!jid) return errResult("jid is required for 'add' action.");
          if (tagsList.length === 0) return errResult("tags array is required for 'add' action.");
          const contactJid = phoneToJid(String(jid));
          store.addContactTags(contactJid, tagsList);
          return okResult({ jid: contactJid, tags: store.getContactTags(contactJid) });
        }
        case "remove": {
          if (!jid) return errResult("jid is required for 'remove' action.");
          if (tagsList.length === 0) return errResult("tags array is required for 'remove' action.");
          const contactJid = phoneToJid(String(jid));
          store.removeContactTags(contactJid, tagsList);
          return okResult({ jid: contactJid, tags: store.getContactTags(contactJid) });
        }
        case "get": {
          if (!jid) return errResult("jid is required for 'get' action.");
          const contactJid = phoneToJid(String(jid));
          const contact = store.getContact(contactJid);
          return okResult({
            jid: contactJid,
            name: contact?.name || contact?.notify || null,
            tags: store.getContactTags(contactJid),
          });
        }
        case "list": {
          const allTags: string[] = store.getAllTags();
          const counts: Record<string, number> = {};
          for (const t of allTags) {
            counts[t] = store.listByTag(t).length;
          }
          return okResult({ tags: allTags, counts });
        }
        case "list_by_tag": {
          if (!tag) return errResult("tag is required for 'list_by_tag' action.");
          const jids: string[] = store.listByTag(String(tag));
          const contacts = jids.map((j) => {
            const c = store.getContact(j);
            return {
              jid: j,
              phone: jidToPhone(j),
              name: c?.name || c?.notify || null,
              tags: store.getContactTags(j),
            };
          });
          return okResult({ tag, count: contacts.length, contacts });
        }
        default:
          return errResult(`Unknown action: ${action}. Use: set, add, remove, get, list, list_by_tag.`);
      }
    },
    schema: contactTagsSchema,
  },
] satisfies ActionDef[];
