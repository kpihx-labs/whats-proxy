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

export const batchSendTextSchema = z.object({
  jids: z.array(z.string()),
  text: z.string(),
  delay_ms: z.number().or(z.string()).optional(),
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

// ── Channels (5) ────────────────────────────────────────────────────────────

export const channelCreateSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  picture: z.string().optional(),
});

export const channelInfoSchema = z.object({
  jid: z.string(),
});

export const channelManageSchema = z.object({
  jid: z.string(),
  action: z.string(),
});

export const channelUpdateSchema = z.object({
  jid: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  picture: z.string().optional(),
});

export const channelDeleteSchema = z.object({
  jid: z.string(),
});

// ── Labels (3) ──────────────────────────────────────────────────────────────

export const labelManageSchema = z.object({
  action: z.string(),
  label_id: z.string().optional(),
  name: z.string().optional(),
  color: z.number().or(z.string()).optional(),
});

export const labelChatSchema = z.object({
  action: z.string(),
  jid: z.string(),
  label_id: z.string(),
});

export const labelMessageSchema = z.object({
  action: z.string(),
  jid: z.string(),
  message_id: z.string(),
  label_id: z.string(),
});

// ── Profile (4) ─────────────────────────────────────────────────────────────

export const profileNameSchema = z.object({
  name: z.string(),
});

export const profileAboutSchema = z.object({
  text: z.string(),
});

export const profilePictureSchema = z.object({
  source: z.string(),
});

export const profilePrivacySchema = z.object({
  action: z.string(),
  setting: z.string().optional(),
  value: z.string().optional(),
});

// ── Analytics (5) ───────────────────────────────────────────────────────────

export const analyticsOverviewSchema = z.object({
  top_chats: z.number().or(z.string()).optional(),
  top_tokens: z.number().or(z.string()).optional(),
  top_senders: z.number().or(z.string()).optional(),
  days: z.number().or(z.string()).optional(),
});

export const analyticsTopChatsSchema = z.object({
  limit: z.number().or(z.string()).optional(),
  sort_by: z.string().optional(),
});

export const analyticsChatInsightsSchema = z.object({
  jid: z.string(),
  top_tokens: z.number().or(z.string()).optional(),
  top_senders: z.number().or(z.string()).optional(),
  days: z.number().or(z.string()).optional(),
  recent_messages: z.number().or(z.string()).optional(),
});

export const analyticsTimelineSchema = z.object({
  jid: z.string().optional(),
  days: z.number().or(z.string()).optional(),
});

export const analyticsSearchSchema = z.object({
  query: z.string(),
  jid: z.string().optional(),
  jids: z.array(z.string()).optional(),
  limit: z.number().or(z.string()).optional(),
  since: z.number().or(z.string()).optional(),
  until: z.number().or(z.string()).optional(),
});

// ── Overview (2) ────────────────────────────────────────────────────────────

export const whatsupSchema = z.object({
  since: z.number().or(z.string()).optional(),
  until: z.number().or(z.string()).optional(),
  watchlists: z.array(z.string()).optional(),
  limit_per_chat: z.number().or(z.string()).optional(),
});

export const findMessagesSchema = z.object({
  query: z.string(),
  since: z.number().or(z.string()).optional(),
  until: z.number().or(z.string()).optional(),
  limit: z.number().or(z.string()).optional(),
  watchlist_only: z.unknown().optional(),
});

// ── Digest (2) ──────────────────────────────────────────────────────────────

export const messagesMultiSchema = z.object({
  jids: z.array(z.string()).optional(),
  watchlist: z.string().optional(),
  limit_per_chat: z.number().or(z.string()).optional(),
  since: z.number().or(z.string()).optional(),
  until: z.number().or(z.string()).optional(),
  include_types: z.array(z.string()).optional(),
  exclude_types: z.array(z.string()).optional(),
});

export const dailyDigestSchema = z.object({
  jids: z.array(z.string()).optional(),
  watchlist: z.string().optional(),
  since: z.number().or(z.string()).optional(),
  until: z.number().or(z.string()).optional(),
  limit_per_chat: z.number().or(z.string()).optional(),
  exclude_types: z.array(z.string()).optional(),
});

// ── Tags (1) ────────────────────────────────────────────────────────────────

export const contactTagsSchema = z.object({
  action: z.string(),
  jid: z.string().optional(),
  tags: z.array(z.string()).optional(),
  tag: z.string().optional(),
});

// ── Watchlists (1) ──────────────────────────────────────────────────────────

export const watchlistSchema = z.object({
  action: z.string(),
  name: z.string().optional(),
  jids: z.array(z.string()).optional(),
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

export const searchMessagesSchema = z.object({
  query: z.string(),
  jid: z.string().optional(),
  jids: z.array(z.string()).optional(),
  limit: z.number().or(z.string()).optional(),
  since: z.number().or(z.string()).optional(),
  until: z.number().or(z.string()).optional(),
  include_types: z.array(z.string()).optional(),
  exclude_types: z.array(z.string()).optional(),
});

export const mediaDownloadSchema = z.object({
  message_id: z.string(),
});

export const mediaCleanupSchema = z.object({});

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
  "batch-send-text": batchSendTextSchema,
  // Chats
  "chat-list": chatListSchema,
  "chat-read": chatReadSchema,
  "chat-manage": chatManageSchema,
  "chat-star": chatStarSchema,
  "chat-disappearing": chatDisappearingSchema,
  // Contacts
  "contact-check": contactCheckSchema,
  "contact-info": contactInfoSchema,
  "contact-picture": contactPictureSchema,
  "contact-block": contactBlockSchema,
  "contact-business": contactBusinessSchema,
  "contact-list": contactListSchema,
  // Groups
  "group-create": groupCreateSchema,
  "group-info": groupInfoSchema,
  "group-list": groupListSchema,
  "group-subject": groupSubjectSchema,
  "group-description": groupDescriptionSchema,
  "group-participants": groupParticipantsSchema,
  "group-leave": groupLeaveSchema,
  "group-invite": groupInviteSchema,
  "group-settings": groupSettingsSchema,
  "group-picture": groupPictureSchema,
  // Channels
  "channel-create": channelCreateSchema,
  "channel-info": channelInfoSchema,
  "channel-manage": channelManageSchema,
  "channel-update": channelUpdateSchema,
  "channel-delete": channelDeleteSchema,
  // Labels
  "label-manage": labelManageSchema,
  "label-chat": labelChatSchema,
  "label-message": labelMessageSchema,
  // Profile
  "profile-name": profileNameSchema,
  "profile-about": profileAboutSchema,
  "profile-picture": profilePictureSchema,
  "profile-privacy": profilePrivacySchema,
  // Analytics
  "analytics-overview": analyticsOverviewSchema,
  "analytics-top-chats": analyticsTopChatsSchema,
  "analytics-chat-insights": analyticsChatInsightsSchema,
  "analytics-timeline": analyticsTimelineSchema,
  "analytics-search": analyticsSearchSchema,
  // Overview
  "whatsup": whatsupSchema,
  "find-messages": findMessagesSchema,
  // Digest
  "messages-multi": messagesMultiSchema,
  "daily-digest": dailyDigestSchema,
  // Tags
  "contact-tags": contactTagsSchema,
  // Watchlists
  "watchlist": watchlistSchema,
  // Utils
  "connection-status": connectionStatusSchema,
  "guide": guideSchema,
  "presence": presenceSchema,
  "read-messages": readMessagesSchema,
  "search-messages": searchMessagesSchema,
  "media-download": mediaDownloadSchema,
  "media-cleanup": mediaCleanupSchema,
};
