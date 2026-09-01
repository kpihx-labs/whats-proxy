/**
 * whats-proxy — Community actions (13).
 *
 * community-list, community-info, community-groups, community-pending,
 * community-create, community-leave, community-subject, community-description,
 * community-participants, community-link, community-unlink, community-invite,
 * community-join.
 *
 * WhatsApp Communities — umbrella structures that group multiple sub-groups
 * under a single entity. Uses Baileys' communities.js socket extension.
 */

import type { ActionDef } from "./types.ts";
import { requireApproval } from "../decorators.ts";
import { phoneToJid, okResult, errResult } from "../helpers.ts";
import { generateMessageID, generateMessageIDV2 } from "@whiskeysockets/baileys";
import {
  communityListSchema, communityInfoSchema, communityGroupsSchema, communityPendingSchema,
  communityCreateSchema, communityLeaveSchema, communitySubjectSchema, communityDescriptionSchema,
  communityParticipantsSchema, communityLinkSchema, communityUnlinkSchema, communityInviteSchema,
  communityJoinSchema,
} from "./schemas.ts";

/** Safe wrapper: runs a Baileys community method with a timeout.
 *  Returns the result or throws an Error with a descriptive message. */
async function safeCall<T>(fn: () => Promise<T>, timeoutMs = 30000): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("WhatsApp did not respond (timeout)")), timeoutMs)),
  ]);
}

export default [
  // ── Read-only (4) ──────────────────────────────────────────────────────

  {
    meta: {
      action: "community-list",
      category: "communities",
      description: "List all WhatsApp Communities the current account participates in.",
      arguments: [],
      example: {},
      returns: "{ total, communities }",
    },
    handler: async (_args: Record<string, unknown>, { sock }) => {
      const data = await (sock as any).communityFetchAllParticipating();
      const communities = Object.values(data as Record<string, any>).map((c: any) => ({
        jid: c.id,
        subject: c.subject,
        owner: c.owner,
        size: c.size,
        description: c.desc,
      }));
      return okResult({ total: communities.length, communities });
    },
    schema: communityListSchema,
    docstring: `List all WhatsApp Communities the current account participates in.

Examples:
    - List all communities:
        \`whats-proxy do community-list '{}'\`
        → {"total":2,"communities":[{"jid":"120363...@g.us","subject":"Team","owner":"...","size":5,"description":"..."}]}
    - Empty list:
        \`whats-proxy do community-list '{}'\`
        → {"total":0,"communities":[]}`,
  },
  {
    meta: {
      action: "community-info",
      category: "communities",
      description: "Get full metadata for a WhatsApp Community: subject, description, owner, size, linked groups, etc.",
      arguments: [
        { name: "jid", description: "Community JID.", required: true },
      ],
      example: { jid: "120363000000000@g.us" },
      returns: "community metadata object",
    },
    handler: async ({ jid }, { sock, store }) => {
      const j = String(jid);
      // Try communityMetadata → groupMetadata → store cache
      try {
        const meta = await (sock as any).communityMetadata(j);
        return okResult(meta);
      } catch {
        try {
          const meta = await sock.groupMetadata(j);
          return okResult({ ...meta, isCommunity: true });
        } catch {
          const cached = store.getGroupMeta(j);
          if (cached) return okResult({ ...cached, isCommunity: true });
          return errResult(`Failed to get community info for ${j}`);
        }
      }
    },
    schema: communityInfoSchema,
    docstring: `Get full metadata for a WhatsApp Community.

Parameters:
    - jid (required): Community JID (ends with @g.us).

Examples:
    - Get community info:
        \`whats-proxy do community-info '{"jid":"120363000000000@g.us"}'\`
        → {"id":"120363...","subject":"Team","size":5,"description":"...","linkedParent":null,"participants":[{"id":"...","admin":"superadmin"}]}
    - Non-existent community:
        \`whats-proxy do community-info '{"jid":"120363000000000@g.us"}'\`
        → {"meta":{"status":"error","comment":"Failed to get community info: ..."}}`,
  },
  {
    meta: {
      action: "community-groups",
      category: "communities",
      description: "List all sub-groups linked to a community.",
      arguments: [
        { name: "jid", description: "Community JID or a linked sub-group JID.", required: true },
      ],
      example: { jid: "120363000000000@g.us" },
      returns: "{ communityJid, isCommunity, linkedGroups }",
    },
    handler: async ({ jid }, { sock }) => {
      try {
        const data = await (sock as any).communityFetchLinkedGroups(String(jid));
        return okResult(data);
      } catch (err) {
        return errResult(`Failed to fetch linked groups: ${(err as Error).message}`);
      }
    },
    schema: communityGroupsSchema,
    docstring: `List all sub-groups linked to a community.

If you pass a sub-group JID, the function automatically resolves to its parent community.

Parameters:
    - jid (required): Community JID or a linked sub-group JID.

Examples:
    - List linked groups:
        \`whats-proxy do community-groups '{"jid":"120363000000000@g.us"}'\`
        → {"communityJid":"120363...","isCommunity":true,"linkedGroups":[{"id":"120363...","subject":"General","size":10}]}
    - From a sub-group:
        \`whats-proxy do community-groups '{"jid":"120363...@g.us"}'\`
        → {"communityJid":"120363...","isCommunity":false,"linkedGroups":[...]}`,
  },
  {
    meta: {
      action: "community-pending",
      category: "communities",
      description: "List pending membership approval requests for a community.",
      arguments: [
        { name: "jid", description: "Community JID.", required: true },
      ],
      example: { jid: "120363000000000@g.us" },
      returns: "{ total, requests }",
    },
    handler: async ({ jid }, { sock }) => {
      try {
        const requests = await (sock as any).communityRequestParticipantsList(String(jid));
        return okResult({ total: requests.length, requests });
      } catch (err) {
        return errResult(`Failed to list pending requests: ${(err as Error).message}`);
      }
    },
    schema: communityPendingSchema,
    docstring: `List pending membership approval requests for a community.

Parameters:
    - jid (required): Community JID.

Examples:
    - List pending requests:
        \`whats-proxy do community-pending '{"jid":"120363000000000@g.us"}'\`
        → {"total":1,"requests":[{"jid":"33612345678@s.whatsapp.net"}]}
    - No pending requests:
        \`whats-proxy do community-pending '{"jid":"120363000000000@g.us"}'\`
        → {"total":0,"requests":[]}`,
  },

  // ── Write (HITL required) (9) ─────────────────────────────────────────

  {
    meta: {
      action: "community-create",
      category: "communities",
      description: "Create a new WhatsApp Community.",
      arguments: [
        { name: "subject", description: "Community name.", required: true },
        { name: "description", description: "Community description.", required: false },
      ],
      example: { subject: "Team Project" },
      returns: "{ status, jid, subject }",
    },
    handler: requireApproval("default")(async ({ subject, description }, { sock }) => {
      const descriptionId = generateMessageID().substring(0, 12);
      let jid: string | null = null;
      try {
        // Replicate the create IQ (native communityCreate discards the raw result
        // via parseGroupResult, which only looks for a <group> node — community
        // creation returns a <community> node, so we extract the id ourselves).
        const result = await safeCall(() => (sock as any).query({
          tag: "iq",
          attrs: { type: "set", xmlns: "w:g2", to: "@g.us" },
          content: [{
            tag: "create",
            attrs: { subject: String(subject), key: generateMessageIDV2() },
            content: [
              {
                tag: "description",
                attrs: { id: descriptionId },
                content: [{ tag: "body", attrs: {}, content: Buffer.from(description ? String(description) : "", "utf-8") }],
              },
              { tag: "parent", attrs: { default_membership_approval_mode: "request_required" } },
              { tag: "allow_non_admin_sub_group_creation", attrs: {} },
              { tag: "create_general_chat", attrs: {} },
            ],
          }],
        }));
        const community = (result as any)?.content?.find?.((n: any) => n.tag === "community")
          ?? (result as any)?.content?.[0]?.content?.find?.((n: any) => n.tag === "community");
        const rawId = community?.attrs?.id;
        jid = rawId ? (rawId.includes("@") ? rawId : `${rawId}@g.us`) : null;
      } catch (e) {
        return errResult(`Failed to create community: ${(e as Error).message}`);
      }
      return okResult({ status: "created", jid, subject });
    }),
    schema: communityCreateSchema,
    docstring: `Create a new WhatsApp Community.

Parameters:
    - subject (required): Community name.
    - description (optional): Community description.

Examples:
    - Create a community:
        \`whats-proxy do community-create '{"subject":"Team Project"}'\`
        → {"status":"created","jid":"120363...","subject":"Team Project"}
    - Create with description:
        \`whats-proxy do community-create '{"subject":"Lab Team","description":"Research coordination"}'\`
        → {"status":"created","jid":"120363...","subject":"Lab Team"}`,
  },
  {
    meta: {
      action: "community-leave",
      category: "communities",
      description: "Leave a WhatsApp Community. You will lose access to all sub-groups.",
      arguments: [
        { name: "jid", description: "Community JID.", required: true },
      ],
      example: { jid: "120363000000000@g.us" },
      returns: "{ status, jid }",
    },
    handler: requireApproval("default")(async ({ jid }, { sock }) => {
      try { await safeCall(() => (sock as any).communityLeave(String(jid))); }
      catch (e) { return errResult(`Failed to leave community: ${(e as Error).message}`); }
      return okResult({ status: "left", jid: String(jid) });
    }),
    schema: communityLeaveSchema,
    docstring: `Leave a WhatsApp Community. You will lose access to all its sub-groups.

Parameters:
    - jid (required): Community JID.

Examples:
    - Leave a community:
        \`whats-proxy do community-leave '{"jid":"120363000000000@g.us"}'\`
        → {"status":"left","jid":"120363000000000@g.us"}`,
  },
  {
    meta: {
      action: "community-subject",
      category: "communities",
      description: "Update a community's name/subject.",
      arguments: [
        { name: "jid", description: "Community JID.", required: true },
        { name: "subject", description: "New community name.", required: true },
      ],
      example: { jid: "120363000000000@g.us", subject: "New Name" },
      returns: "{ status, jid, subject }",
    },
    handler: requireApproval("default")(async ({ jid, subject }, { sock }) => {
      try { await safeCall(() => (sock as any).communityUpdateSubject(String(jid), String(subject))); }
      catch (e) { return errResult(`Failed to update subject: ${(e as Error).message}`); }
      return okResult({ status: "updated", jid: String(jid), subject });
    }),
    schema: communitySubjectSchema,
    docstring: `Update a community's name/subject.

Parameters:
    - jid (required): Community JID.
    - subject (required): New community name.

Examples:
    - Update community name:
        \`whats-proxy do community-subject '{"jid":"120363000000000@g.us","subject":"New Name"}'\`
        → {"status":"updated","jid":"120363...","subject":"New Name"}`,
  },
  {
    meta: {
      action: "community-description",
      category: "communities",
      description: "Update a community's description.",
      arguments: [
        { name: "jid", description: "Community JID.", required: true },
        { name: "description", description: "New description.", required: true },
      ],
      example: { jid: "120363000000000@g.us", description: "Updated description" },
      returns: "{ status, jid }",
    },
    handler: requireApproval("default")(async ({ jid, description }, { sock }) => {
      try {
        // groupUpdateDescription resolves the previous description's id via
        // groupMetadata (<query request="interactive">, which WhatsApp answers for
        // communities too) then issues the set. The fork's communityUpdateDescription
        // is broken for communities — its communityMetadata does a non-null
        // getBinaryNodeChild(result, 'community')! that throws on group-shaped replies
        // (upstream Baileys PR #2425).
        await safeCall(() => (sock as any).groupUpdateDescription(String(jid), String(description)));
      } catch (e) {
        return errResult(`Failed to update description: ${(e as Error).message}`);
      }
      return okResult({ status: "updated", jid: String(jid) });
    }),
    schema: communityDescriptionSchema,
    docstring: `Update a community's description.

Parameters:
    - jid (required): Community JID.
    - description (required): New description.

Examples:
    - Update description:
        \`whats-proxy do community-description '{"jid":"120363000000000@g.us","description":"Updated"}'\`
        → {"status":"updated","jid":"120363..."}`,
  },
  {
    meta: {
      action: "community-participants",
      category: "communities",
      description: "Remove participants from a community.",
      arguments: [
        { name: "jid", description: "Community JID.", required: true },
        { name: "action", description: "remove.", required: true },
        { name: "participants", description: "Array of JIDs or phone numbers.", required: true },
      ],
      example: { jid: "120363000000000@g.us", action: "add", participants: ["33612345678"] },
      returns: "{ status, results }",
    },
    handler: requireApproval("default")(async ({ jid, action, participants }, { sock }) => {
      const pList = (Array.isArray(participants) ? participants : [participants]).map(phoneToJid);
      let results;
      try {
        results = await safeCall(() => (sock as any).communityParticipantsUpdate(String(jid), pList, String(action)));
      } catch (e) { return errResult(`Failed to update participants: ${(e as Error).message}`); }
      return okResult({ status: action, jid: String(jid), results });
    }),
    schema: communityParticipantsSchema,
    docstring: `Remove participants from a community.

Use the invite workflow to add participants:
  1. community-invite get → get invite code
  2. Other account runs community-join with that code

Parameters:
    - jid (required): Community JID.
    - action (required): remove.
    - participants (required): Array of JIDs or phone numbers.

Examples:
    - Remove a participant:
        \`whats-proxy do community-participants '{"jid":"120363000000000@g.us","action":"remove","participants":["33612345678"]}'\`
        → {"status":"remove","jid":"120363...","results":[{"jid":"336123...","status":"200"}]}`,
  },
  {
    meta: {
      action: "community-link",
      category: "communities",
      description: "Link an existing group to a community as a sub-group.",
      arguments: [
        { name: "group_jid", description: "Group JID to link.", required: true },
        { name: "community_jid", description: "Community JID.", required: true },
      ],
      example: { group_jid: "120363...@g.us", community_jid: "120363...@g.us" },
      returns: "{ status, group_jid, community_jid }",
    },
    handler: requireApproval("default")(async ({ group_jid, community_jid }, { sock }) => {
      try { await safeCall(() => (sock as any).communityLinkGroup(String(group_jid), String(community_jid))); }
      catch (e) { return errResult(`Failed to link group: ${(e as Error).message}`); }
      return okResult({ status: "linked", group_jid: String(group_jid), community_jid: String(community_jid) });
    }),
    schema: communityLinkSchema,
    docstring: `Link an existing group to a community as a sub-group.

Parameters:
    - group_jid (required): Group JID to link.
    - community_jid (required): Parent community JID.

Examples:
    - Link a group:
        \`whats-proxy do community-link '{"group_jid":"120363...@g.us","community_jid":"120363...@g.us"}'\`
        → {"status":"linked","group_jid":"120363...","community_jid":"120363..."}`,
  },
  {
    meta: {
      action: "community-unlink",
      category: "communities",
      description: "Unlink a sub-group from a community.",
      arguments: [
        { name: "group_jid", description: "Sub-group JID to unlink.", required: true },
        { name: "community_jid", description: "Community JID.", required: true },
      ],
      example: { group_jid: "120363...@g.us", community_jid: "120363...@g.us" },
      returns: "{ status, group_jid, community_jid }",
    },
    handler: requireApproval("default")(async ({ group_jid, community_jid }, { sock }) => {
      try { await safeCall(() => (sock as any).communityUnlinkGroup(String(group_jid), String(community_jid))); }
      catch (e) { return errResult(`Failed to unlink group: ${(e as Error).message}`); }
      return okResult({ status: "unlinked", group_jid: String(group_jid), community_jid: String(community_jid) });
    }),
    schema: communityUnlinkSchema,
    docstring: `Unlink a sub-group from a community.

Parameters:
    - group_jid (required): Sub-group JID to unlink.
    - community_jid (required): Community JID.

Examples:
    - Unlink a group:
        \`whats-proxy do community-unlink '{"group_jid":"120363...@g.us","community_jid":"120363...@g.us"}'\`
        → {"status":"unlinked","group_jid":"120363...","community_jid":"120363..."}`,
  },
  {
    meta: {
      action: "community-invite",
      category: "communities",
      description: "Get or revoke a community invite code.",
      arguments: [
        { name: "jid", description: "Community JID.", required: true },
        { name: "action", description: "get or revoke.", required: true },
      ],
      example: { jid: "120363000000000@g.us", action: "get" },
      returns: "{ status, code }",
    },
    handler: requireApproval("default")(async ({ jid, action }, { sock }) => {
      try {
        if (String(action) === "get") {
          const code = await safeCall(() => (sock as any).communityInviteCode(String(jid)));
          return okResult({ status: "fetched", jid: String(jid), code: code || null });
        } else {
          const newCode = await safeCall(() => (sock as any).communityRevokeInvite(String(jid)));
          return okResult({ status: "revoked", jid: String(jid), code: newCode || null });
        }
      } catch (e) { return errResult(`Failed: ${(e as Error).message}`); }
    }),
    schema: communityInviteSchema,
    docstring: `Get or revoke a community invite code.

Parameters:
    - jid (required): Community JID.
    - action (required): get | revoke.

Examples:
    - Get invite code:
        \`whats-proxy do community-invite '{"jid":"120363000000000@g.us","action":"get"}'\`
        → {"status":"fetched","jid":"120363...","code":"abc123"}
    - Revoke invite code:
        \`whats-proxy do community-invite '{"jid":"120363000000000@g.us","action":"revoke"}'\`
        → {"status":"revoked","jid":"120363...","code":"xyz789"}`,
  },
  {
    meta: {
      action: "community-join",
      category: "communities",
      description: "Join a community via an invite code.",
      arguments: [
        { name: "code", description: "Invite code or full invite link.", required: true },
      ],
      example: { code: "abc123" },
      returns: "{ status, jid }",
    },
    handler: requireApproval("default")(async ({ code }, { sock }) => {
      const inviteCode = String(code).includes("chat.whatsapp.com") ? String(code).split("/").pop() : String(code);
      let jid;
      try { jid = await safeCall(() => (sock as any).communityAcceptInvite(inviteCode)); }
      catch (e) { return errResult(`Failed to join community: ${(e as Error).message}`); }
      return okResult({ status: "joined", jid: jid || null });
    }),
    schema: communityJoinSchema,
    docstring: `Join a community via an invite code.

Parameters:
    - code (required): Invite code or full invite link.

Examples:
    - Join with code:
        \`whats-proxy do community-join '{"code":"abc123"}'\`
        → {"status":"joined","jid":"120363..."}
    - Join with link:
        \`whats-proxy do community-join '{"code":"https://chat.whatsapp.com/abc123"}'\`
        → {"status":"joined","jid":"120363..."}`,
  },
] satisfies ActionDef[];
