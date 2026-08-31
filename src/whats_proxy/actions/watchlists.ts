/**
 * whats-proxy — Watchlist actions (1).
 *
 * watchlist (manage_watchlist).
 *
 * Faithful port of whats-mcp `watchlists.js`.
 */

import type { ActionDef } from "./types.ts";
import { watchlistSchema } from "./schemas.ts";
import { phoneToJid, okResult, errResult } from "../helpers.ts";

const VALID_ACTIONS = ["set", "add", "remove", "get", "list", "delete"];

export default [
  {
    meta: {
      action: "watchlist",
      category: "overview",
      description:
        "Dynamically manage personal chat watchlists — named groups of chats to monitor together. Watchlists persist across sessions and are used by whatsup and daily-digest. Call this when the user says: 'suis ces groupes', 'ajoute X à ma watchlist', 'track these chats', 'crée une watchlist famille', 'quelles sont mes watchlists'. Actions: set (define/replace entirely), add (append JIDs), remove (remove JIDs), get (view one watchlist with chat names), list (view all watchlists), delete (delete).",
      arguments: [
        { name: "action", description: "Action to perform: set | add | remove | get | list | delete.", required: true },
        { name: "name", description: "Watchlist name (e.g. 'family', 'x24'). Required for all actions except list.", required: false },
        { name: "jids", description: "Array of chat JIDs or phone numbers. Required for set/add/remove.", required: false },
      ],
      example: { action: "set", name: "x24", jids: ["120363000000000@g.us"] },
      returns: "{ name, count, chats } | { total, watchlists }",
    },
    handler: async ({ action, name, jids }, { store, config }) => {
      if (!VALID_ACTIONS.includes(String(action))) {
        return errResult(`Unknown action '${action}'. Valid: ${VALID_ACTIONS.join(", ")}`);
      }

      if (action === "list") {
        const storeWLs = store.listWatchlists();
        const configWLs = config?.watchlists || {};
        const merged = { ...configWLs, ...storeWLs };
        const entries = Object.entries(merged).map(([n, wjids]) => {
          const chats = (wjids as string[]).map((jid) => {
            const ch = store.getChat(jid);
            return { jid, name: ch?.name || ch?.subject || jid };
          });
          return {
            name: n,
            count: (wjids as string[]).length,
            source: storeWLs[n] ? "dynamic" : "config",
            chats,
          };
        });
        return okResult({ total: entries.length, watchlists: entries });
      }

      if (!name) {
        return errResult(`Parameter 'name' is required for action '${action}'.`);
      }
      const wlName = String(name);

      if (action === "get") {
        const wjids = store.resolveWatchlist(wlName, config?.watchlists);
        if (!wjids) {
          const all = [...new Set([
            ...Object.keys(store.listWatchlists()),
            ...Object.keys(config?.watchlists || {}),
          ])];
          return errResult(`Watchlist '${wlName}' not found. Available: ${all.join(", ") || "none"}`);
        }
        const chats = wjids.map((jid: string) => {
          const ch = store.getChat(jid);
          return { jid, name: ch?.name || ch?.subject || jid };
        });
        return okResult({ name: wlName, count: wjids.length, chats });
      }

      if (action === "delete") {
        const existed = store.deleteWatchlist(wlName);
        return okResult({ status: existed ? "deleted" : "not_found", name: wlName });
      }

      const resolvedJids = (Array.isArray(jids) ? jids : []).map((j) => phoneToJid(String(j)));
      if (resolvedJids.length === 0) {
        return errResult(`Parameter 'jids' must be a non-empty array for action '${action}'.`);
      }

      const withNames = (list: string[]) => list.map((jid) => {
        const ch = store.getChat(jid);
        return { jid, name: ch?.name || ch?.subject || jid };
      });

      if (action === "set") {
        store.setWatchlist(wlName, resolvedJids);
        return okResult({ status: "set", name: wlName, count: resolvedJids.length, chats: withNames(resolvedJids) });
      }

      if (action === "add") {
        store.addToWatchlist(wlName, resolvedJids);
        const updated = store.getWatchlist(wlName) || [];
        return okResult({ status: "added", name: wlName, added: resolvedJids.length, total: updated.length, chats: withNames(updated) });
      }

      store.removeFromWatchlist(wlName, resolvedJids);
      const updated = store.getWatchlist(wlName) || [];
      return okResult({ status: "removed", name: wlName, removed: resolvedJids.length, remaining: updated.length, chats: withNames(updated) });
    },
    schema: watchlistSchema,
    docstring: `Dynamically manage personal chat watchlists — named groups of chats to monitor together.

Parameters:
    - action (required): Action to perform: set | add | remove | get | list | delete.
    - name (optional): Watchlist name (e.g. 'family', 'x24'). Required for all actions except list.
    - jids (optional): Array of chat JIDs or phone numbers. Required for set/add/remove.

Examples:
    - Create a watchlist:
        \`whats-proxy do watchlist '{"action":"set","name":"x24","jids":["120363000000000@g.us","33612345678"]}'\`
        → {"status":"set","name":"x24","count":2,"chats":[{"jid":"120363000000000@g.us","name":"X24 Project"},{"jid":"33612345678@s.whatsapp.net","name":"Alice"}]}
    - List all watchlists:
        \`whats-proxy do watchlist '{"action":"list"}'\`
        → {"total":3,"watchlists":[{"name":"x24","count":2,"source":"dynamic","chats":[]},{"name":"family","count":5,"source":"config","chats":[]}]}
    - Add to an existing watchlist:
        \`whats-proxy do watchlist '{"action":"add","name":"x24","jids":["33600000000"]}'\`
        → {"status":"added","name":"x24","added":1,"total":3,"chats":[{"jid":"120363000000000@g.us","name":"X24 Project"},{"jid":"33612345678@s.whatsapp.net","name":"Alice"},{"jid":"33600000000@s.whatsapp.net","name":"Bob"}]}`,
  },
] satisfies ActionDef[];
