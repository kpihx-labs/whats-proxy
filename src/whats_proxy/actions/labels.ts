/**
 * whats-proxy — Label actions (WhatsApp Business) (3).
 *
 * label-manage, label-chat, label-message.
 *
 * Faithful port of whats-mcp `labels.js`.
 */

import type { ActionDef } from "./types.ts";
import { phoneToJid, okResult, errResult } from "../helpers.ts";

export default [
  {
    meta: {
      action: "label-manage",
      category: "labels",
      description:
        "Create, edit, or delete a WhatsApp Business label. Labels are used to organize chats and messages. Note: Only available for WhatsApp Business accounts.",
      arguments: [
        { name: "action", description: "Action to perform: create | edit | delete | list.", required: true },
        { name: "label_id", description: "Label ID (required for edit/delete).", required: false },
        { name: "name", description: "Label name (required for create/edit).", required: false },
        { name: "color", description: "Label color index (0-19). Optional for create/edit.", required: false },
      ],
      example: { action: "create", name: "Important", color: 3 },
      returns: "{ status, label } | { count, labels }",
    },
    handler: async ({ action, label_id, name, color }, { sock }) => {
      if (action === "list") {
        try {
          const labels: any[] = await (sock as any).getLabels();
          return okResult({
            count: labels.length,
            labels: labels.map((l) => ({
              id: l.id,
              name: l.name,
              color: l.color,
              predefined: l.predefinedId !== undefined,
            })),
          });
        } catch (err) {
          return errResult("Could not fetch labels. Are you using a WhatsApp Business account? " + (err as Error).message);
        }
      }

      if (action === "create") {
        if (!name) return errResult("Label name is required for create.");
        const result = await (sock as any).addLabel({ name: String(name), color: color ?? 0 });
        return okResult({ status: "created", label: result });
      }

      if (action === "edit") {
        if (!label_id) return errResult("label_id is required for edit.");
        const updates: Record<string, unknown> = {};
        if (name !== undefined) updates.name = name;
        if (color !== undefined) updates.color = color;
        await (sock as any).editLabel(String(label_id), updates);
        return okResult({ status: "edited", label_id });
      }

      if (action === "delete") {
        if (!label_id) return errResult("label_id is required for delete.");
        await (sock as any).deleteLabel(String(label_id));
        return okResult({ status: "deleted", label_id });
      }

      return errResult(`Unknown action: ${action}`);
    },
  },
  {
    meta: {
      action: "label-chat",
      category: "labels",
      description: "Add or remove a label from a chat (WhatsApp Business).",
      arguments: [
        { name: "action", description: "Add or remove the label.", required: true },
        { name: "jid", description: "Chat JID or phone number.", required: true },
        { name: "label_id", description: "Label ID to add/remove.", required: true },
      ],
      example: { action: "add", jid: "33612345678", label_id: "1" },
      returns: "{ status, jid, label_id }",
    },
    handler: async ({ action, jid, label_id }, { sock }) => {
      const chatJid = phoneToJid(String(jid));
      if (action === "add") {
        await (sock as any).addChatLabel(chatJid, String(label_id));
        return okResult({ status: "label_added", jid: chatJid, label_id });
      }
      if (action === "remove") {
        await (sock as any).removeChatLabel(chatJid, String(label_id));
        return okResult({ status: "label_removed", jid: chatJid, label_id });
      }
      return errResult(`Unknown action: ${action}`);
    },
  },
  {
    meta: {
      action: "label-message",
      category: "labels",
      description: "Add or remove a label from a specific message (WhatsApp Business).",
      arguments: [
        { name: "action", description: "Add or remove the label.", required: true },
        { name: "jid", description: "Chat JID.", required: true },
        { name: "message_id", description: "Message ID to label.", required: true },
        { name: "label_id", description: "Label ID.", required: true },
      ],
      example: { action: "add", jid: "33612345678", message_id: "ABC123", label_id: "1" },
      returns: "{ status, jid, message_id, label_id }",
    },
    handler: async ({ action, jid, message_id, label_id }, { sock }) => {
      const chatJid = phoneToJid(String(jid));
      if (action === "add") {
        await (sock as any).addMessageLabel(chatJid, String(message_id), String(label_id));
        return okResult({ status: "label_added", jid: chatJid, message_id, label_id });
      }
      if (action === "remove") {
        await (sock as any).removeMessageLabel(chatJid, String(message_id), String(label_id));
        return okResult({ status: "label_removed", jid: chatJid, message_id, label_id });
      }
      return errResult(`Unknown action: ${action}`);
    },
  },
] satisfies ActionDef[];
