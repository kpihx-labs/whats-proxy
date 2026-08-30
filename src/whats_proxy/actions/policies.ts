/**
 * Declarative safety policy for registered WhatsApp actions.
 *
 * This is the single visible source of truth for review, preflight, and
 * verification requirements. The registry applies these policies exactly once
 * when it builds the executable action map, so a CLI path cannot bypass them.
 *
 * Examples:
 *   policyFor("send-text", { jid: "33600000000", text: "Hello" })?.approval
 *   // => true
 *   policyFor("chat-list", {})
 *   // => undefined
 */

import type { ActionContext, ActionDef, ActionHandler } from "./types.ts";
import { requestApproval } from "../hitl.ts";
import { errResult } from "../helpers.ts";

type Predicate = (args: Record<string, unknown>) => boolean;
type Preflight = (args: Record<string, unknown>, context: ActionContext) => string | null | Promise<string | null>;
type Verify = (args: Record<string, unknown>, context: ActionContext) => Record<string, unknown>;

export interface ActionPolicy {
  /** Whether the action must open the local approval page. */
  approval: boolean | Predicate;
  /** Optional destructive-target validation before review. */
  preflight?: Preflight;
  /** Locked fields that reviewers may not redirect after preflight. */
  identityFields?: string[];
  /** Whether a conditional preflight actually locked its identity fields. */
  lockIdentity?: Predicate;
  /** Optional read-back proof appended to data.verification. */
  verify?: Verify;
}

const always = (): boolean => true;
const actionIs = (...values: string[]): Predicate => (args) => values.includes(String(args.action));
const hasDangerousChatOperation = actionIs("delete", "clear");
const hasDangerousInviteOperation = actionIs("revoke", "join");
const hasDangerousContactOperation = actionIs("block", "unblock");
const deletesWatchlist = actionIs("delete");
const mutatesLocalCollection = (args: Record<string, unknown>): boolean => !["get", "list", "list_by_tag"].includes(String(args.action));

const requireStoreMessage: Preflight = (args, context) =>
  context.store.getMessage(String(args.message_id))
    ? null
    : `Message ${String(args.message_id)} is not present in the local store; refusing a destructive review without a preflighted target.`;
const requireWatchlist: Preflight = (args, context) =>
  context.store.resolveWatchlist(String(args.name), context.config.watchlists)
    ? null
    : `Watchlist ${String(args.name)} does not exist.`;
const requireChat: Preflight = (args, context) => {
  const jid = String(args.jid);
  const normalized = jid.includes("@") ? jid : `${jid}@s.whatsapp.net`;
  return context.store.getChat(normalized)
    ? null
    : `Chat ${jid} is not present in the local store.`;
};
const requireGroup: Preflight = async (args, context) => {
  try {
    await context.sock.groupMetadata(String(args.jid));
    return null;
  } catch {
    return `Group ${String(args.jid)} could not be read before destructive review.`;
  }
};
const requireChannel: Preflight = async (args, context) => {
  try {
    await (context.sock as any).newsletterMetadata("jid", String(args.jid));
    return null;
  } catch {
    return `Channel ${String(args.jid)} could not be read before destructive review.`;
  }
};
const requireLabel: Preflight = async (args, context) => {
  try {
    const labels: Array<{ id?: string }> = await (context.sock as any).getLabels();
    return labels.some((label) => label.id === String(args.label_id))
      ? null
      : `Label ${String(args.label_id)} does not exist.`;
  } catch {
    return `Label ${String(args.label_id)} could not be read before destructive review.`;
  }
};

const verifyWatchlist: Verify = (args, context) => {
  const name = String(args.name);
  const actual = context.store.getWatchlist(name) ?? null;
  return {
    method: "local Store read-back",
    checked: ["watchlist"],
    actual,
    ok: String(args.action) === "delete" ? actual === null : actual !== null,
  };
};
const verifyContactTags: Verify = (args, context) => {
  const jid = String(args.jid).includes("@") ? String(args.jid) : `${String(args.jid)}@s.whatsapp.net`;
  return {
    method: "local Store read-back",
    checked: ["contact_tags"],
    actual: context.store.getContactTags(jid),
    ok: true,
  };
};

/** Policies for every action with a consequential side effect. */
export const ACTION_POLICIES: Record<string, ActionPolicy> = {
  "send-text": { approval: always }, "send-image": { approval: always },
  "send-video": { approval: always }, "send-audio": { approval: always },
  "send-document": { approval: always }, "send-sticker": { approval: always },
  "send-location": { approval: always }, "send-contact": { approval: always },
  "send-reaction": { approval: always }, "send-poll": { approval: always },
  "edit-message": { approval: always },
  "delete-message": { approval: always, preflight: requireStoreMessage, identityFields: ["jid", "message_id"] },
  "forward-message": { approval: always }, "batch-send-text": { approval: always },
  "chat-manage": { approval: always, preflight: (args, context) => hasDangerousChatOperation(args) ? requireChat(args, context) : null, identityFields: ["jid"], lockIdentity: hasDangerousChatOperation },
  "chat-star": { approval: always }, "chat-disappearing": { approval: always },
  "contact-block": { approval: hasDangerousContactOperation },
  "group-create": { approval: always }, "group-subject": { approval: always },
  "group-description": { approval: always }, "group-participants": { approval: always },
  "group-leave": { approval: always, preflight: requireGroup, identityFields: ["jid"] },
  "group-invite": { approval: hasDangerousInviteOperation, preflight: (args, context) => String(args.action) === "revoke" ? requireGroup(args, context) : null, identityFields: ["jid"], lockIdentity: actionIs("revoke") },
  "group-settings": { approval: always }, "group-picture": { approval: always },
  "channel-create": { approval: always }, "channel-manage": { approval: always },
  "channel-update": { approval: always },
  "channel-delete": { approval: always, preflight: requireChannel, identityFields: ["jid"] },
  "label-manage": { approval: always, preflight: (args, context) => String(args.action) === "delete" ? requireLabel(args, context) : null, identityFields: ["label_id"], lockIdentity: actionIs("delete") },
  "label-chat": { approval: always }, "label-message": { approval: always },
  "profile-name": { approval: always }, "profile-about": { approval: always },
  "profile-picture": { approval: always }, "profile-privacy": { approval: actionIs("set") },
  "contact-tags": { approval: mutatesLocalCollection, verify: verifyContactTags },
  "watchlist": { approval: mutatesLocalCollection, preflight: (args, context) => deletesWatchlist(args) ? requireWatchlist(args, context) : null, identityFields: ["name"], lockIdentity: deletesWatchlist, verify: verifyWatchlist },
  "presence": { approval: always }, "read-messages": { approval: always },
  "media-download": { approval: always }, "media-cleanup": { approval: always },
};

/**
 * Attach declared preflight, approval, and verification behavior to one action.
 *
 * Args:
 *   definition: Registry action definition to protect.
 *   policy: Optional policy from ACTION_POLICIES.
 *
 * Returns:
 *   The same action definition with a non-bypassable protected handler.
 *
 * Examples:
 *   protectAction(definition, { approval: true }).handler
 *   // => async protected action handler
 *   protectAction(definition, undefined).handler === definition.handler
 *   // => true
 */
export function protectAction(definition: ActionDef, policy: ActionPolicy | undefined): ActionDef {
  if (!policy) return definition;
  const original: ActionHandler = definition.handler;
  return {
    ...definition,
    handler: async (args, context) => {
      // Zod payload validation (safety net — before HITL).
      if (definition.schema) {
        const result = definition.schema.safeParse(args);
        if (!result.success) {
          return errResult(`Payload validation failed: ${result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
        }
        args = result.data;
      }
      const needsApproval = typeof policy.approval === "function" ? policy.approval(args) : policy.approval;
      if (needsApproval && policy.preflight) {
        const error = await policy.preflight(args, context);
        if (error) return errResult(error);
      }
      let approvedArgs = args;
      if (needsApproval) {
        const review = await requestApproval(definition.meta.action, args);
        if (review.status !== "approved" || !review.payload) {
          return { meta: { status: "rejected", comment: review.comment, edited: false }, data: null };
        }
        const locksIdentity = policy.preflight && (policy.lockIdentity?.(args) ?? true);
        if (locksIdentity && policy.identityFields?.some((field) => review.payload![field] !== args[field])) {
          return errResult(`Reviewed payload changed a locked preflight identity field: ${policy.identityFields.join(", ")}.`);
        }
        approvedArgs = review.payload;
        const output = await original(approvedArgs, context);
        if (output.meta.status !== "error") {
          output.meta.status = "approved";
          output.meta.comment = review.comment;
          output.meta.edited = review.edited;
        }
        if (policy.verify && output.meta.status !== "error") {
          const data = output.data as Record<string, unknown>;
          data.verification = policy.verify(approvedArgs, context);
        }
        return output;
      }
      const output = await original(approvedArgs, context);
      if (policy.verify && output.meta.status !== "error") {
        const data = output.data as Record<string, unknown>;
        data.verification = policy.verify(approvedArgs, context);
      }
      return output;
    },
  };
}

/**
 * Return the declared policy for one registered action.
 *
 * Args:
 *   name: Kebab-case action name from the registry.
 *
 * Returns:
 *   The action policy, or undefined when the action is read-only.
 *
 * Examples:
 *   policyFor("send-text")?.approval
 *   // => [Function: always]
 *   policyFor("chat-list")
 *   // => undefined
 */
export function policyFor(name: string): ActionPolicy | undefined {
  return ACTION_POLICIES[name];
}
