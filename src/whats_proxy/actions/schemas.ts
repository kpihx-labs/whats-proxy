/**
 * whats-proxy — Zod payload schemas for all actions.
 *
 * Single source of truth for per-action validation. Schemas are permissive
 * enough to pass existing `meta.arguments` but strict enough to catch
 * type errors (e.g. `priority: "banana"`). Every action registered in the
 * registry MUST have a matching schema entry.
 */

import { z } from "zod";

// ── Messaging (14) ───────────────────────────────────────────────────────────

export const sendTextSchema = z.object({
  jid: z.string(),
  text: z.string(),
  quoted_id: z.string().optional(),
  mentions: z.array(z.string()).optional(),
});

export const sendImageSchema = z.object({
  jid: z.string(),
  source: z.string(),
  caption: z.string().optional(),
  quoted_id: z.string().optional(),
});

export const sendVideoSchema = z.object({
  jid: z.string(),
  source: z.string(),
  caption: z.string().optional(),
  gif_playback: z.unknown().optional(),
  ptv: z.unknown().optional(),
  quoted_id: z.string().optional(),
});

export const sendAudioSchema = z.object({
  jid: z.string(),
  source: z.string(),
  ptt: z.unknown().optional(),
  quoted_id: z.string().optional(),
});

export const sendDocumentSchema = z.object({
  jid: z.string(),
  source: z.string(),
  filename: z.string().optional(),
  mimetype: z.string().optional(),
  caption: z.string().optional(),
  quoted_id: z.string().optional(),
});

export const sendStickerSchema = z.object({
  jid: z.string(),
  source: z.string(),
  quoted_id: z.string().optional(),
});

export const sendLocationSchema = z.object({
  jid: z.string(),
  latitude: z.number().or(z.string()),
  longitude: z.number().or(z.string()),
  name: z.string().optional(),
  address: z.string().optional(),
  quoted_id: z.string().optional(),
});

export const sendContactSchema = z.object({
  jid: z.string(),
  contacts: z.array(z.record(z.string(), z.unknown())),
  quoted_id: z.string().optional(),
});

export const sendReactionSchema = z.object({
  jid: z.string(),
  message_id: z.string(),
  emoji: z.string(),
  from_me: z.unknown().optional(),
});

export const sendPollSchema = z.object({
  jid: z.string(),
  question: z.string(),
  options: z.array(z.string()),
  selectable_count: z.number().or(z.string()).optional(),
});

export const editMessageSchema = z.object({
  jid: z.string(),
  message_id: z.string(),
  new_text: z.string(),
});

export const deleteMessageSchema = z.object({
  jid: z.string(),
  message_id: z.string(),
  from_me: z.unknown().optional(),
  participant: z.string().optional(),
});

export const forwardMessageSchema = z.object({
  to_jid: z.string(),
  message_id: z.string(),
});

export const sendBatchPartText = z.object({ type: z.literal("text"), text: z.string(), mentions: z.array(z.string()).optional(), quoted_id: z.string().optional() });
export const sendBatchPartImage = z.object({ type: z.literal("image"), source: z.string(), caption: z.string().optional(), quoted_id: z.string().optional() });
export const sendBatchPartVideo = z.object({ type: z.literal("video"), source: z.string(), caption: z.string().optional(), gif_playback: z.boolean().optional(), ptv: z.boolean().optional(), quoted_id: z.string().optional() });
export const sendBatchPartAudio = z.object({ type: z.literal("audio"), source: z.string(), ptt: z.boolean().optional(), quoted_id: z.string().optional() });
export const sendBatchPartDocument = z.object({ type: z.literal("document"), source: z.string(), filename: z.string().optional(), mimetype: z.string().optional(), caption: z.string().optional(), quoted_id: z.string().optional() });
export const sendBatchPartSticker = z.object({ type: z.literal("sticker"), source: z.string(), quoted_id: z.string().optional() });
export const sendBatchPartLocation = z.object({ type: z.literal("location"), latitude: z.number(), longitude: z.number(), name: z.string().optional(), address: z.string().optional(), quoted_id: z.string().optional() });
export const sendBatchPartContact = z.object({ type: z.literal("contact"), contacts: z.array(z.object({ name: z.string(), phone: z.string() })), quoted_id: z.string().optional() });
export const sendBatchPartPoll = z.object({ type: z.literal("poll"), question: z.string(), options: z.array(z.string()).min(2).max(12), selectable_count: z.number().optional(), quoted_id: z.string().optional() });

export const sendBatchSchema = z.object({
  to: z.union([z.string(), z.array(z.string()).min(1)]),
  parts: z.array(z.discriminatedUnion("type", [
    sendBatchPartText, sendBatchPartImage, sendBatchPartVideo, sendBatchPartAudio,
    sendBatchPartDocument, sendBatchPartSticker, sendBatchPartLocation,
    sendBatchPartContact, sendBatchPartPoll,
  ])).min(1),
  quoted_id: z.string().optional(),
  delay_ms: z.number().optional(),
});

// ── Chats (5) ───────────────────────────────────────────────────────────────

export const chatListSchema = z.object({
  limit: z.number().or(z.string()).optional(),
  offset: z.number().or(z.string()).optional(),
  filter: z.string().optional(),
});

export const chatReadSchema = z.object({
  jid: z.string(),
  limit: z.number().or(z.string()).optional(),
  before_id: z.string().optional(),
  fetch_history: z.unknown().optional(),
  history_count: z.number().or(z.string()).optional(),
  history_wait_ms: z.number().or(z.string()).optional(),
  since: z.number().or(z.string()).optional(),
  until: z.number().or(z.string()).optional(),
  include_types: z.array(z.string()).optional(),
  exclude_types: z.array(z.string()).optional(),
});

export const chatManageSchema = z.object({
  jid: z.string(),
  action: z.string(),
  mute_duration: z.number().or(z.string()).optional(),
});

export const chatStarSchema = z.object({
  jid: z.string(),
  message_id: z.string(),
  star: z.unknown().optional(),
  from_me: z.unknown().optional(),
});

export const chatDisappearingSchema = z.object({
  jid: z.string(),
  duration: z.number().or(z.string()),
});

export const messageStatusSchema = z.object({
  action: z.enum(["get", "sent"]),
  message_id: z.string().optional(),
  chat_jid: z.string().optional(),
  limit: z.number().optional(),
});

// ── Contacts (6) ────────────────────────────────────────────────────────────

export const contactCheckSchema = z.object({
  phones: z.array(z.string()),
});

export const contactInfoSchema = z.object({
  jid: z.string(),
});

export const contactPictureSchema = z.object({
  jid: z.string(),
  type: z.string().optional(),
});

export const contactBlockSchema = z.object({
  action: z.string(),
  jid: z.string().optional(),
});

export const contactBusinessSchema = z.object({
  jid: z.string(),
});

export const contactListSchema = z.object({
  limit: z.number().or(z.string()).optional(),
  offset: z.number().or(z.string()).optional(),
  name: z.string().optional(),
  tag: z.string().optional(),
  has_tags: z.unknown().optional(),
  exclude_groups: z.unknown().optional(),
});

// ── Groups (10) ─────────────────────────────────────────────────────────────

export const groupCreateSchema = z.object({
  subject: z.string(),
  participants: z.array(z.string()),
  description: z.string().optional(),
});

export const groupInfoSchema = z.object({
  jid: z.string(),
  recent_messages_limit: z.number().or(z.string()).optional(),
  hydrate_messages: z.unknown().optional(),
  history_count: z.number().or(z.string()).optional(),
  history_wait_ms: z.number().or(z.string()).optional(),
  include_participants: z.unknown().optional(),
  participant_limit: z.number().or(z.string()).optional(),
});

export const groupListSchema = z.object({
  limit: z.number().or(z.string()).optional(),
});

export const groupSubjectSchema = z.object({
  jid: z.string(),
  subject: z.string(),
});

export const groupDescriptionSchema = z.object({
  jid: z.string(),
  description: z.string(),
});

export const groupParticipantsSchema = z.object({
  jid: z.string(),
  action: z.string(),
  participants: z.array(z.string()),
});

export const groupLeaveSchema = z.object({
  jid: z.string(),
});

export const groupDisbandSchema = z.object({
  jid: z.string(),
});

export const groupInviteSchema = z.object({
  action: z.string(),
  jid: z.string().optional(),
  code: z.string().optional(),
});

export const groupSettingsSchema = z.object({
  jid: z.string(),
  announce: z.unknown().optional(),
  locked: z.unknown().optional(),
  ephemeral: z.number().or(z.string()).optional(),
  member_add_mode: z.unknown().optional(),
  join_approval_mode: z.unknown().optional(),
});

export const groupPictureSchema = z.object({
  jid: z.string(),
  source: z.string(),
});

// ── Profile (4) ─────────────────────────────────────────────────────────────

export const profileNameSchema = z.object({
  action: z.enum(["get", "edit"]),
  name: z.string().optional(),
});

export const profileAboutSchema = z.object({
  action: z.enum(["get", "edit"]),
  text: z.string().optional(),
});

export const profilePictureSchema = z.object({
  action: z.enum(["get", "edit", "remove"]),
  source: z.string().optional(),
});

export const profilePrivacySchema = z.object({
  action: z.enum(["get", "set"]),
  setting: z.string().optional(),
  value: z.string().optional(),
});

export const contactPresenceCheckSchema = z.object({
  jid: z.string(),
  timeout_ms: z.number().optional(),
});

// ── Overview (2) ────────────────────────────────────────────────────────────

export const whatsupSchema = z.object({
  since: z.number().or(z.string()).optional(),
  until: z.number().or(z.string()).optional(),
});

export const findMessagesSchema = z.object({
  query: z.string(),
  since: z.number().or(z.string()).optional(),
  until: z.number().or(z.string()).optional(),
  limit: z.number().or(z.string()).optional(),
});

// ── Chats (6) ──────────────────────────────────────────────────────────────

export const chatReadBatchSchema = z.object({
  jids: z.array(z.string()),
  limit_per_chat: z.number().or(z.string()).optional(),
  since: z.number().or(z.string()).optional(),
  until: z.number().or(z.string()).optional(),
  include_types: z.array(z.string()).optional(),
  exclude_types: z.array(z.string()).optional(),
});

// ── Tags (1) ────────────────────────────────────────────────────────────────

export const contactTagsSchema = z.object({
  action: z.string(),
  jid: z.string().optional(),
  tags: z.array(z.string()).optional(),
  tag: z.string().optional(),
});

// ── Utils (7) ───────────────────────────────────────────────────────────────

export const connectionStatusSchema = z.object({});

export const guideSchema = z.object({
  category: z.string().optional(),
});

export const presenceSchema = z.object({
  type: z.string(),
  jid: z.string().optional(),
});

export const readMessagesSchema = z.object({
  jid: z.string(),
  message_ids: z.array(z.string()),
  participant: z.string().optional(),
});

export const mediaDownloadSchema = z.object({
  message_id: z.string(),
});

export const mediaCleanupSchema = z.object({});

export const mediaUploadSchema = z.object({
  jid: z.string(),
  source: z.string(),
  mimetype: z.string().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
  quoted_id: z.string().optional(),
  ptt: z.boolean().optional(),
});

// ── Stories (5) ─────────────────────────────────────────────────────────────

export const storyListSchema = z.object({
  jid: z.string().optional(),
  limit: z.number().or(z.string()).optional(),
});

export const storyDownloadSchema = z.object({
  message_id: z.string(),
});

export const storyViewSchema = z.object({
  message_id: z.string(),
});

// ── Communities (13) ─────────────────────────────────────────────────────────

export const communityListSchema = z.object({});

export const communityInfoSchema = z.object({
  jid: z.string(),
});

export const communityGroupsSchema = z.object({
  jid: z.string(),
});

export const communityPendingSchema = z.object({
  jid: z.string(),
});

export const communityCreateSchema = z.object({
  subject: z.string(),
  description: z.string().optional(),
});

export const communityLeaveSchema = z.object({
  jid: z.string(),
});

export const communitySubjectSchema = z.object({
  jid: z.string(),
  subject: z.string(),
});

export const communityDescriptionSchema = z.object({
  jid: z.string(),
  description: z.string(),
});

export const communityParticipantsSchema = z.object({
  jid: z.string(),
  action: z.enum(["remove"]),
  participants: z.array(z.string()),
});

export const communityLinkSchema = z.object({
  group_jid: z.string(),
  community_jid: z.string(),
});

export const communityUnlinkSchema = z.object({
  group_jid: z.string(),
  community_jid: z.string(),
});

export const communityInviteSchema = z.object({
  jid: z.string(),
  action: z.enum(["get", "revoke"]),
});

export const communityJoinSchema = z.object({
  code: z.string(),
});

// ── Schema registry (action name → schema) — used by audit tests ───────────

export const SCHEMAS: Record<string, z.ZodObject<Record<string, z.ZodTypeAny>>> = {
  // Messaging
  "send-text": sendTextSchema,
  "send-image": sendImageSchema,
  "send-video": sendVideoSchema,
  "send-audio": sendAudioSchema,
  "send-document": sendDocumentSchema,
  "send-sticker": sendStickerSchema,
  "send-location": sendLocationSchema,
  "send-contact": sendContactSchema,
  "send-reaction": sendReactionSchema,
  "send-poll": sendPollSchema,
  "edit-message": editMessageSchema,
  "delete-message": deleteMessageSchema,
  "forward-message": forwardMessageSchema,
  "send-batch": sendBatchSchema,
  "media-upload": mediaUploadSchema,
  // Chats
  "chat-list": chatListSchema,
  "chat-read": chatReadSchema,
  "chat-manage": chatManageSchema,
  "chat-star": chatStarSchema,
  "chat-disappearing": chatDisappearingSchema,
  "message-status": messageStatusSchema,
  // Contacts
  "contact-check": contactCheckSchema,
  "contact-info": contactInfoSchema,
  "contact-picture": contactPictureSchema,
  "contact-block": contactBlockSchema,
  "contact-business": contactBusinessSchema,
  "contact-list": contactListSchema,
  "contact-presence-check": contactPresenceCheckSchema,
  // Groups
  "group-create": groupCreateSchema,
  "group-info": groupInfoSchema,
  "group-list": groupListSchema,
  "group-subject": groupSubjectSchema,
  "group-description": groupDescriptionSchema,
  "group-participants": groupParticipantsSchema,
  "group-leave": groupLeaveSchema,
  "group-disband": groupDisbandSchema,
  "group-invite": groupInviteSchema,
  "group-settings": groupSettingsSchema,
  "group-picture": groupPictureSchema,
  // Profile
  "profile-name": profileNameSchema,
  "profile-about": profileAboutSchema,
  "profile-picture": profilePictureSchema,
  "profile-privacy": profilePrivacySchema,
  // Overview
  "whatsup": whatsupSchema,
  "find-messages": findMessagesSchema,
  // Chats
  "chat-read-batch": chatReadBatchSchema,
  // Tags
  "contact-tags": contactTagsSchema,
  // Utils
  "connection-status": connectionStatusSchema,
  "guide": guideSchema,
  "presence": presenceSchema,
  "read-messages": readMessagesSchema,
  "media-download": mediaDownloadSchema,
  "media-cleanup": mediaCleanupSchema,
  // Stories
  "story-list": storyListSchema,
  "story-download": storyDownloadSchema,
  "story-view": storyViewSchema,
  // Communities
  "community-list": communityListSchema,
  "community-info": communityInfoSchema,
  "community-groups": communityGroupsSchema,
  "community-pending": communityPendingSchema,
  "community-create": communityCreateSchema,
  "community-leave": communityLeaveSchema,
  "community-subject": communitySubjectSchema,
  "community-description": communityDescriptionSchema,
  "community-participants": communityParticipantsSchema,
  "community-link": communityLinkSchema,
  "community-unlink": communityUnlinkSchema,
  "community-invite": communityInviteSchema,
  "community-join": communityJoinSchema,
};
