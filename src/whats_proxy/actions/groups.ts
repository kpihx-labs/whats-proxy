/**
 * whats-proxy — Group actions (10).
 *
 * group-create, group-info, group-list, group-subject, group-description,
 * group-participants, group-leave, group-invite, group-settings, group-picture.
 *
 * Faithful port of whats-mcp `groups.js`.
 */

import type { ActionDef } from "./types.ts";
import { phoneToJid, groupJid, isGroupJid, jidToPhone, resolveMedia, okResult, errResult, formatMessage } from "../helpers.ts";
import { fetchAdditionalHistory, type HistorySyncResult } from "./history.ts";

/** Normalize a JID expected to be a group: bare ID → @g.us, else pass through. */
function _ensureGroupJid(jid: string): string {
  if (!jid) return jid;
  if (jid.includes("@")) return jid;
  return groupJid(jid);
}

function _fmtParticipant(p: any) {
  return {
    jid: p.id,
    phone: jidToPhone(p.id),
    admin: p.admin || null,
  };
}

function _fmtGroupMeta(meta: any, options: any = {}) {
  const allParticipants = (meta.participants || []).map(_fmtParticipant);
  const includeParticipants = options.includeParticipants !== false;
  const participantLimit = includeParticipants
    ? Math.max(0, options.participantLimit ?? 200)
    : 0;
  const participants = includeParticipants
    ? allParticipants.slice(0, participantLimit)
    : undefined;

  return {
    jid: meta.id,
    subject: meta.subject,
    subject_owner: meta.subjectOwner || null,
    subject_time: meta.subjectTime ? Number(meta.subjectTime) : null,
    description: meta.desc || null,
    description_id: meta.descId || null,
    owner: meta.owner || null,
    creation_time: meta.creation ? Number(meta.creation) : null,
    recent_messages: options.recentMessages || [],
    recent_message_count: (options.recentMessages || []).length,
    history_sync: options.historySync || null,
    participant_count: allParticipants.length,
    participants_returned: includeParticipants ? participants!.length : 0,
    participants_truncated: includeParticipants ? participants!.length < allParticipants.length : allParticipants.length > 0,
    participants,
    size: meta.size || allParticipants.length,
    announce: meta.announce ?? false,
    restrict: meta.restrict ?? false,
    ephemeral: meta.ephemeralDuration || 0,
    invite_code: meta.inviteCode || null,
    linked_parent: meta.linkedParent || null,
  };
}

export default [
  {
    meta: {
      action: "group-create",
      category: "groups",
      description: "Create a new WhatsApp group. You must provide at least 1 participant besides yourself.",
      arguments: [
        { name: "subject", description: "Group name/subject.", required: true },
        { name: "participants", description: "Array of participant JIDs or phone numbers to add.", required: true },
        { name: "description", description: "Optional group description.", required: false },
      ],
      example: { subject: "X24 Project", participants: ["33612345678"] },
      returns: "{ status, jid, subject, participants }",
    },
    handler: async ({ subject, participants, description }, { sock }) => {
      const list = Array.isArray(participants) ? participants.map(String) : [];
      const jids = list.map(phoneToJid);
      const result: any = await sock.groupCreate(String(subject), jids);
      if (description && result.id) {
        try {
          await sock.groupUpdateDescription(result.id, String(description));
        } catch { /* ignore description failure */ }
      }
      return okResult({
        status: "created",
        jid: result.id,
        subject: result.subject || subject,
        participants: result.participants || jids.map((j) => ({ jid: j })),
      });
    },
  },
  {
    meta: {
      action: "group-info",
      category: "groups",
      description:
        "Get full metadata for a group: subject, description, participants, settings, etc.",
      arguments: [
        { name: "jid", description: "Group JID (e.g. 120363xxx@g.us).", required: true },
        { name: "recent_messages_limit", description: "Include up to this many recent cached messages (default 10, max 50).", required: false },
        { name: "hydrate_messages", description: "If true (default), request additional older history when the local cache is too small.", required: false },
        { name: "history_count", description: "How many older messages to request during on-demand history sync (default: max(recent_messages_limit, 50), max 200).", required: false },
        { name: "history_wait_ms", description: "How long to wait for history-sync events (default 3500ms, max 15000ms).", required: false },
        { name: "include_participants", description: "Whether to include participant details in the response (default true).", required: false },
        { name: "participant_limit", description: "Maximum number of participants to include (default 200).", required: false },
      ],
      example: { jid: "120363000000000@g.us", recent_messages_limit: 10 },
      returns: "{ jid, subject, description, participants, announce, restrict, ... }",
    },
    handler: async ({
      jid,
      recent_messages_limit,
      hydrate_messages,
      history_count,
      history_wait_ms,
      include_participants,
      participant_limit,
    }, { sock, store }) => {
      const gJid = _ensureGroupJid(String(jid));
      if (!isGroupJid(gJid)) {
        return errResult("Provided JID is not a group. Group JIDs end with @g.us.");
      }
      let meta: any;
      try {
        meta = await sock.groupMetadata(gJid);
      } catch {
        meta = store.getGroupMeta(gJid);
        if (!meta) return errResult(`Could not retrieve metadata for group ${gJid}.`);
      }
      store.setGroupMeta(gJid, meta);

      const recentLimit = Math.min(Math.max(Number(recent_messages_limit) || 10, 0), 50);
      let historySync: HistorySyncResult = {
        enabled: hydrate_messages !== false,
        requested: false,
        received: false,
        reason: recentLimit > 0 ? "cache_sufficient" : "disabled",
        before_count: store.countMessages(gJid),
        after_count: store.countMessages(gJid),
        anchor_id: null,
        requested_count: 0,
        wait_ms: 0,
      };

      if (recentLimit > 0 && hydrate_messages !== false) {
        const cachedMessages = store.getMessages(gJid, recentLimit);
        if (cachedMessages.length < recentLimit) {
          historySync = await fetchAdditionalHistory({
            sock,
            store,
            jid: gJid,
            limit: recentLimit,

            historyCount: history_count as number | undefined,
            waitMs: history_wait_ms as number | undefined,
            enabled: hydrate_messages !== false,
          });
        }
      }

      const recentMessages = recentLimit > 0
        ? store.getMessages(gJid, recentLimit).map(formatMessage).filter(Boolean)
        : [];

      return okResult(_fmtGroupMeta(meta, {
        recentMessages,
        historySync,
        includeParticipants: include_participants,
        participantLimit: participant_limit,
      }));
    },
  },
  {
    meta: {
      action: "group-list",
      category: "groups",
      description: "List all groups you are a member of.",
      arguments: [
        { name: "limit", description: "Max number of groups to return (default 50).", required: false },
      ],
      example: { limit: 50 },
      returns: "{ count, groups }",
    },
    handler: async ({ limit }, { sock, store }) => {
      const seen = new Set<string>();
      const groups: any[] = [];
      const lim = Number(limit) || 50;

      for (const chat of store.listChats(10000)) {
        if (!isGroupJid(chat.id) || seen.has(chat.id)) continue;
        seen.add(chat.id);
        groups.push(chat);
        if (groups.length >= lim) break;
      }

      if (groups.length < lim) {
        for (const meta of store.groupMeta.values()) {
          if (!meta?.id || seen.has(meta.id)) continue;
          seen.add(meta.id);
          groups.push({
            id: meta.id,
            name: meta.subject,
            conversationTimestamp: meta.subjectTime || meta.creation || 0,
          });
          if (groups.length >= lim) break;
        }
      }

      const results = [];
      for (const g of groups) {
        let meta = store.getGroupMeta(g.id);
        if (!meta) {
          try {
            meta = await sock.groupMetadata(g.id);
            store.setGroupMeta(g.id, meta);
          } catch { /* skip */ }
        }
        results.push({
          jid: g.id,
          subject: meta?.subject || g.name || g.id,
          participant_count: meta?.participants?.length || meta?.size || null,
          creation_time: meta?.creation ? Number(meta.creation) : null,
          announce: meta?.announce ?? null,
        });
      }

      return okResult({ count: results.length, groups: results });
    },
  },
  {
    meta: {
      action: "group-subject",
      category: "groups",
      description: "Change the group name/subject.",
      arguments: [
        { name: "jid", description: "Group JID.", required: true },
        { name: "subject", description: "New group name (max 25 characters).", required: true },
      ],
      example: { jid: "120363000000000@g.us", subject: "New Name" },
      returns: "{ status, jid, subject }",
    },
    handler: async ({ jid, subject }, { sock }) => {
      const gJid = _ensureGroupJid(String(jid));
      await sock.groupUpdateSubject(gJid, String(subject));
      return okResult({ status: "updated", jid: gJid, subject });
    },
  },
  {
    meta: {
      action: "group-description",
      category: "groups",
      description: "Update or clear the group description.",
      arguments: [
        { name: "jid", description: "Group JID.", required: true },
        { name: "description", description: "New description. Empty string to clear.", required: true },
      ],
      example: { jid: "120363000000000@g.us", description: "Updated description" },
      returns: "{ status, jid }",
    },
    handler: async ({ jid, description }, { sock }) => {
      const gJid = _ensureGroupJid(String(jid));
      await sock.groupUpdateDescription(gJid, description ? String(description) : undefined);
      return okResult({ status: "updated", jid: gJid });
    },
  },
  {
    meta: {
      action: "group-participants",
      category: "groups",
      description: "Add, remove, promote (to admin), or demote (from admin) group participants.",
      arguments: [
        { name: "jid", description: "Group JID.", required: true },
        { name: "action", description: "Action to perform: add | remove | promote | demote.", required: true },
        { name: "participants", description: "Array of participant JIDs or phone numbers.", required: true },
      ],
      example: { jid: "120363000000000@g.us", action: "add", participants: ["33612345678"] },
      examples: [
        { description: "Add a participant", payload: { jid: "120363000000000@g.us", action: "add", participants: ["33612345678"] } },
        { description: "Promote an admin", payload: { jid: "120363000000000@g.us", action: "promote", participants: ["33612345678"] } },
        { description: "Remove a participant", payload: { jid: "120363000000000@g.us", action: "remove", participants: ["33612345678"] } },
      ],
      returns: "{ status, jid, participants }",
    },
    handler: async ({ jid, action, participants }, { sock }) => {
      const gJid = _ensureGroupJid(String(jid));
      const list = Array.isArray(participants) ? participants.map(String) : [];
      const pJids = list.map(phoneToJid);
      const result: any = await sock.groupParticipantsUpdate(gJid, pJids, String(action) as any);
      return okResult({
        status: action,
        jid: gJid,
        participants: result || pJids.map((p) => ({ jid: p, status: "ok" })),
      });
    },
  },
  {
    meta: {
      action: "group-leave",
      category: "groups",
      description: "Leave a group.",
      arguments: [
        { name: "jid", description: "Group JID.", required: true },
      ],
      example: { jid: "120363000000000@g.us" },
      returns: "{ status, jid }",
    },
    handler: async ({ jid }, { sock }) => {
      const gJid = _ensureGroupJid(String(jid));
      await sock.groupLeave(gJid);
      return okResult({ status: "left", jid: gJid });
    },
  },
  {
    meta: {
      action: "group-invite",
      category: "groups",
      description:
        "Get, revoke, or join a group via invite link/code. 'get' returns the current invite link, 'revoke' generates a new one, 'join' joins the group given an invite code.",
      arguments: [
        { name: "action", description: "Action to perform: get | revoke | join.", required: true },
        { name: "jid", description: "Group JID (required for 'get' and 'revoke').", required: false },
        { name: "code", description: "Invite code or full link (required for 'join'). E.g. 'ABcdEfGhIjK' or 'https://chat.whatsapp.com/ABcdEfGhIjK'.", required: false },
      ],
      example: { action: "get", jid: "120363000000000@g.us" },
      examples: [
        { description: "Read the current invite", payload: { action: "get", jid: "120363000000000@g.us" } },
        { description: "Revoke and rotate an invite", payload: { action: "revoke", jid: "120363000000000@g.us" } },
        { description: "Join from an invite link", payload: { action: "join", code: "https://chat.whatsapp.com/ABcdEfGhIjK" } },
      ],
      returns: "{ jid, invite_code, invite_link } | { status, jid }",
    },
    handler: async ({ action, jid, code }, { sock }) => {
      if (action === "get") {
        if (!jid) return errResult("JID is required for 'get' action.");
        const gJid = _ensureGroupJid(String(jid));
        const inviteCode = await sock.groupInviteCode(gJid);
        return okResult({
          jid: gJid,
          invite_code: inviteCode,
          invite_link: `https://chat.whatsapp.com/${inviteCode}`,
        });
      }
      if (action === "revoke") {
        if (!jid) return errResult("JID is required for 'revoke' action.");
        const gJid = _ensureGroupJid(String(jid));
        const newCode = await sock.groupRevokeInvite(gJid);
        return okResult({
          jid: gJid,
          invite_code: newCode,
          invite_link: `https://chat.whatsapp.com/${newCode}`,
          note: "Previous invite link has been revoked.",
        });
      }
      if (action === "join") {
        if (!code) return errResult("Invite code is required for 'join' action.");
        const inviteCode = String(code).replace("https://chat.whatsapp.com/", "").trim();
        const gJid = await sock.groupAcceptInvite(inviteCode);
        return okResult({ status: "joined", jid: gJid, invite_code: inviteCode });
      }
      return errResult(`Unknown action: ${action}`);
    },
  },
  {
    meta: {
      action: "group-settings",
      category: "groups",
      description:
        "Update group settings: announcement mode (only admins send), locked mode (only admins edit info), disappearing messages, member add mode, and join approval mode.",
      arguments: [
        { name: "jid", description: "Group JID.", required: true },
        { name: "announce", description: "true = only admins can send messages, false = all members can send.", required: false },
        { name: "locked", description: "true = only admins can edit group info, false = all members can.", required: false },
        { name: "ephemeral", description: "Disappearing messages timer in seconds: 0=off, 86400=24h, 604800=7d, 7776000=90d.", required: false },
        { name: "member_add_mode", description: "true = all members can add participants, false = only admins.", required: false },
        { name: "join_approval_mode", description: "true = admin approval required for join requests.", required: false },
      ],
      example: { jid: "120363000000000@g.us", announce: true },
      returns: "{ status, jid, changes }",
    },
    handler: async ({ jid, announce, locked, ephemeral, member_add_mode, join_approval_mode }, { sock }) => {
      const gJid = _ensureGroupJid(String(jid));
      const updates: string[] = [];

      if (announce !== undefined) {
        await sock.groupSettingUpdate(gJid, announce ? "announcement" : "not_announcement");
        updates.push(`announce=${announce}`);
      }
      if (locked !== undefined) {
        await sock.groupSettingUpdate(gJid, locked ? "locked" : "unlocked");
        updates.push(`locked=${locked}`);
      }
      if (ephemeral !== undefined) {
        await sock.sendMessage(gJid, { disappearingMessagesInChat: Number(ephemeral) } as any);
        updates.push(`ephemeral=${ephemeral}`);
      }
      if (member_add_mode !== undefined) {
        await (sock as any).groupMemberAddMode(gJid, member_add_mode ? "all_member_add" : "admin_add");
        updates.push(`member_add_mode=${member_add_mode}`);
      }
      if (join_approval_mode !== undefined) {
        await (sock as any).groupJoinApprovalMode(gJid, join_approval_mode ? "on" : "off");
        updates.push(`join_approval_mode=${join_approval_mode}`);
      }

      if (updates.length === 0) {
        return errResult("No settings provided. Specify at least one setting to update.");
      }
      return okResult({ status: "updated", jid: gJid, changes: updates });
    },
  },
  {
    meta: {
      action: "group-picture",
      category: "groups",
      description: "Set or update the group profile picture.",
      arguments: [
        { name: "jid", description: "Group JID.", required: true },
        { name: "source", description: "Image source: URL, base64, or local file path.", required: true },
      ],
      example: { jid: "120363000000000@g.us", source: "/path/to/pic.jpg" },
      returns: "{ status, jid }",
    },
    handler: async ({ jid, source }, { sock }) => {
      const gJid = _ensureGroupJid(String(jid));
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
      await sock.updateProfilePicture(gJid, imgBuf);
      return okResult({ status: "updated", jid: gJid });
    },
  },
] satisfies ActionDef[];
