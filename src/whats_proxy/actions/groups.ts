/**
 * whats-proxy — Group actions (10).
 *
 * group-create, group-info, group-list, group-subject, group-description,
 * group-participants, group-leave, group-invite, group-settings, group-picture.
 *
 * Faithful port of whats-mcp `groups.js`.
 */

import type { ActionDef } from "./types.ts";
import { requireApproval, requirePreflight } from "../decorators.ts";
import { groupCreateSchema, groupInfoSchema, groupListSchema, groupSubjectSchema, groupDescriptionSchema, groupParticipantsSchema, groupLeaveSchema, groupInviteSchema, groupSettingsSchema, groupPictureSchema } from "./schemas.ts";
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
    handler: requireApproval("default")(async ({ subject, participants, description }, { sock }) => {
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
    }),
    schema: groupCreateSchema,
    docstring: `Create a new WhatsApp group. You must provide at least 1 participant besides yourself.

Parameters:
    - subject (required): Group name/subject.
    - participants (required): Array of participant JIDs or phone numbers to add.
    - description (optional): Group description.

Examples:
    - Create a group with one participant:
        \`whats-proxy do group-create '{"subject":"X24 Project","participants":["33612345678"]}'\`
        → {"status":"created","jid":"120363000000000@g.us","subject":"X24 Project","participants":[{"jid":"33612345678@s.whatsapp.net"}]}
    - Create a group with description:
        \`whats-proxy do group-create '{"subject":"Sprint Team","participants":["33612345678","33600000000"],"description":"Weekly sprint coordination"}'\`
        → {"status":"created","jid":"120363000000001@g.us","subject":"Sprint Team","participants":[{"jid":"33612345678@s.whatsapp.net"},{"jid":"33600000000@s.whatsapp.net"}]}
    - Create a large group:
        \`whats-proxy do group-create '{"subject":"Event Attendees","participants":["33612345678","33600000000","33611111111","33622222222"]}'\`
        → {"status":"created","jid":"120363000000002@g.us","subject":"Event Attendees","participants":[{"jid":"33612345678@s.whatsapp.net"},{"jid":"33600000000@s.whatsapp.net"},{"jid":"33611111111@s.whatsapp.net"},{"jid":"33622222222@s.whatsapp.net"}]}`,
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
    schema: groupInfoSchema,
    docstring: `Get full metadata for a group: subject, description, participants, settings, etc.

Parameters:
    - jid (required): Group JID (e.g. 120363xxx@g.us).
    - recent_messages_limit (optional): Include up to this many recent cached messages (default 10, max 50).
    - hydrate_messages (optional): If true (default), request additional older history when cache is too small.
    - history_count (optional): How many older messages to request during history sync.
    - history_wait_ms (optional): How long to wait for history-sync events (default 3500ms).
    - include_participants (optional): Whether to include participant details (default true).
    - participant_limit (optional): Maximum number of participants to include (default 200).

Examples:
    - Get group info:
        \`whats-proxy do group-info '{"jid":"120363000000000@g.us"}'\`
        → {"jid":"120363000000000@g.us","subject":"X24 Project","description":"Sprint coordination","participant_count":12,"announce":false,"restrict":false,"ephemeral":0}
    - Get group info without participants:
        \`whats-proxy do group-info '{"jid":"120363000000000@g.us","include_participants":false}'\`
        → {"jid":"120363000000000@g.us","subject":"X24 Project","participant_count":12,"participants_returned":0}
    - Get group with recent messages:
        \`whats-proxy do group-info '{"jid":"120363000000000@g.us","recent_messages_limit":5}'\`
        → {"jid":"120363000000000@g.us","subject":"X24 Project","recent_messages":[{"id":"MSG001","text":"Sprint update","from_me":false}],"recent_message_count":5}`,
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
    schema: groupListSchema,
    docstring: `List all groups you are a member of.

Parameters:
    - limit (optional): Max number of groups to return (default 50).

Examples:
    - List all groups:
        \`whats-proxy do group-list '{}'\`
        → {"count":15,"groups":[{"jid":"120363000000000@g.us","subject":"X24 Project","participant_count":12,"announce":false},{"jid":"120363000000001@g.us","subject":"Family","participant_count":8}]}
    - List with limit:
        \`whats-proxy do group-list '{"limit":5}'\`
        → {"count":5,"groups":[{"jid":"120363000000000@g.us","subject":"X24 Project","participant_count":12}]}
    - List groups (empty):
        \`whats-proxy do group-list '{"limit":100}'\`
        → {"count":0,"groups":[]}`,
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
    handler: requireApproval("default")(async ({ jid, subject }, { sock }) => {
      const gJid = _ensureGroupJid(String(jid));
      await sock.groupUpdateSubject(gJid, String(subject));
      return okResult({ status: "updated", jid: gJid, subject });
    }),
    schema: groupSubjectSchema,
    docstring: `Change the group name/subject.

Parameters:
    - jid (required): Group JID.
    - subject (required): New group name (max 25 characters).

Examples:
    - Rename a group:
        \`whats-proxy do group-subject '{"jid":"120363000000000@g.us","subject":"Sprint Team v2"}'\`
        → {"status":"updated","jid":"120363000000000@g.us","subject":"Sprint Team v2"}
    - Short name update:
        \`whats-proxy do group-subject '{"jid":"120363000000000@g.us","subject":"X24"}'\`
        → {"status":"updated","jid":"120363000000000@g.us","subject":"X24"}
    - Rename using bare ID:
        \`whats-proxy do group-subject '{"jid":"120363000000000","subject":"New Name"}'\`
        → {"status":"updated","jid":"120363000000000@g.us","subject":"New Name"}`,
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
    handler: requireApproval("default")(async ({ jid, description }, { sock }) => {
      const gJid = _ensureGroupJid(String(jid));
      await sock.groupUpdateDescription(gJid, description ? String(description) : undefined);
      return okResult({ status: "updated", jid: gJid });
    }),
    schema: groupDescriptionSchema,
    docstring: `Update or clear the group description.

Parameters:
    - jid (required): Group JID.
    - description (required): New description. Empty string to clear.

Examples:
    - Set group description:
        \`whats-proxy do group-description '{"jid":"120363000000000@g.us","description":"Weekly sprint coordination and updates"}'\`
        → {"status":"updated","jid":"120363000000000@g.us"}
    - Update description:
        \`whats-proxy do group-description '{"jid":"120363000000000@g.us","description":"Updated: daily standups at 9:30"}'\`
        → {"status":"updated","jid":"120363000000000@g.us"}
    - Clear description:
        \`whats-proxy do group-description '{"jid":"120363000000000@g.us","description":""}'\`
        → {"status":"updated","jid":"120363000000000@g.us"}`,
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
    handler: requireApproval("default")(async ({ jid, action, participants }, { sock }) => {
      const gJid = _ensureGroupJid(String(jid));
      const list = Array.isArray(participants) ? participants.map(String) : [];
      const pJids = list.map(phoneToJid);
      const result: any = await sock.groupParticipantsUpdate(gJid, pJids, String(action) as any);
      return okResult({
        status: action,
        jid: gJid,
        participants: result || pJids.map((p) => ({ jid: p, status: "ok" })),
      });
    }),
    schema: groupParticipantsSchema,
    docstring: `Add, remove, promote (to admin), or demote (from admin) group participants.

Parameters:
    - jid (required): Group JID.
    - action (required): Action to perform: add | remove | promote | demote.
    - participants (required): Array of participant JIDs or phone numbers.

Examples:
    - Add a participant:
        \`whats-proxy do group-participants '{"jid":"120363000000000@g.us","action":"add","participants":["33612345678"]}'\`
        → {"status":"add","jid":"120363000000000@g.us","participants":[{"jid":"33612345678@s.whatsapp.net","status":"ok"}]}
    - Promote to admin:
        \`whats-proxy do group-participants '{"jid":"120363000000000@g.us","action":"promote","participants":["33612345678"]}'\`
        → {"status":"promote","jid":"120363000000000@g.us","participants":[{"jid":"33612345678@s.whatsapp.net","status":"ok"}]}
    - Remove a participant:
        \`whats-proxy do group-participants '{"jid":"120363000000000@g.us","action":"remove","participants":["33612345678"]}'\`
        → {"status":"remove","jid":"120363000000000@g.us","participants":[{"jid":"33612345678@s.whatsapp.net","status":"ok"}]}`,
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
    handler: requireApproval("default")(
      requirePreflight(
        async (args, ctx) => {
          try {
            await (ctx as any).sock.groupMetadata(String(args.jid));
          } catch {
            throw new Error(`Group ${String(args.jid)} could not be read before destructive review.`);
          }
        },
        ["jid"],
      )(async ({ jid }, { sock }) => {
        const gJid = _ensureGroupJid(String(jid));
        await sock.groupLeave(gJid);
        return okResult({ status: "left", jid: gJid });
      }),
    ),
    schema: groupLeaveSchema,
    docstring: `Leave a group.

Parameters:
    - jid (required): Group JID.

Examples:
    - Leave a group:
        \`whats-proxy do group-leave '{"jid":"120363000000000@g.us"}'\`
        → {"status":"left","jid":"120363000000000@g.us"}
    - Leave using bare ID:
        \`whats-proxy do group-leave '{"jid":"120363000000000"}'\`
        → {"status":"left","jid":"120363000000000@g.us"}
    - Leave a different group:
        \`whats-proxy do group-leave '{"jid":"120363000000001@g.us"}'\`
        → {"status":"left","jid":"120363000000001@g.us"}`,
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
    schema: groupInviteSchema,
    docstring: `Get, revoke, or join a group via invite link/code.

Parameters:
    - action (required): Action to perform: get | revoke | join.
    - jid (optional): Group JID (required for 'get' and 'revoke').
    - code (optional): Invite code or full link (required for 'join').

Examples:
    - Get the current invite link:
        \`whats-proxy do group-invite '{"action":"get","jid":"120363000000000@g.us"}'\`
        → {"jid":"120363000000000@g.us","invite_code":"ABcdEfGhIjK","invite_link":"https://chat.whatsapp.com/ABcdEfGhIjK"}
    - Revoke and rotate invite:
        \`whats-proxy do group-invite '{"action":"revoke","jid":"120363000000000@g.us"}'\`
        → {"jid":"120363000000000@g.us","invite_code":"XyZ123AbC","invite_link":"https://chat.whatsapp.com/XyZ123AbC","note":"Previous invite link has been revoked."}
    - Join via invite link:
        \`whats-proxy do group-invite '{"action":"join","code":"https://chat.whatsapp.com/ABcdEfGhIjK"}'\`
        → {"status":"joined","jid":"120363000000000@g.us","invite_code":"ABcdEfGhIjK"}`,
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
    handler: requireApproval("default")(async ({ jid, announce, locked, ephemeral, member_add_mode, join_approval_mode }, { sock }) => {
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
    }),
    schema: groupSettingsSchema,
    docstring: `Update group settings: announcement mode, locked mode, disappearing messages, member add mode, and join approval mode.

Parameters:
    - jid (required): Group JID.
    - announce (optional): true = only admins can send messages.
    - locked (optional): true = only admins can edit group info.
    - ephemeral (optional): Disappearing messages timer in seconds.
    - member_add_mode (optional): true = all members can add participants.
    - join_approval_mode (optional): true = admin approval required for join requests.

Examples:
    - Set announcement mode:
        \`whats-proxy do group-settings '{"jid":"120363000000000@g.us","announce":true}'\`
        → {"status":"updated","jid":"120363000000000@g.us","changes":["announce=true"]}
    - Lock group info:
        \`whats-proxy do group-settings '{"jid":"120363000000000@g.us","locked":true,"ephemeral":604800}'\`
        → {"status":"updated","jid":"120363000000000@g.us","changes":["locked=true","ephemeral=604800"]}
    - Enable join approval:
        \`whats-proxy do group-settings '{"jid":"120363000000000@g.us","join_approval_mode":true}'\`
        → {"status":"updated","jid":"120363000000000@g.us","changes":["join_approval_mode=true"]}`,
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
    handler: requireApproval("default")(async ({ jid, source }, { sock }) => {
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
    }),
    schema: groupPictureSchema,
    docstring: `Set or update the group profile picture.

Parameters:
    - jid (required): Group JID.
    - source (required): Image source: URL, base64, or local file path.

Examples:
    - Set group picture from local file:
        \`whats-proxy do group-picture '{"jid":"120363000000000@g.us","source":"/home/user/Pictures/group-logo.jpg"}'\`
        → {"status":"updated","jid":"120363000000000@g.us"}
    - Set group picture from URL:
        \`whats-proxy do group-picture '{"jid":"120363000000000@g.us","source":"https://example.com/logo.png"}'\`
        → {"status":"updated","jid":"120363000000000@g.us"}
    - Update with base64 image:
        \`whats-proxy do group-picture '{"jid":"120363000000000@g.us","source":"data:image/png;base64,iVBOR..."}'\`
        → {"status":"updated","jid":"120363000000000@g.us"}`,
  },
] satisfies ActionDef[];
