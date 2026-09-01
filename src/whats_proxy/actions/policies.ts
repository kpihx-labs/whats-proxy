/**
 * Declarative safety policy for registered WhatsApp actions.
 *
 * Two-tier resolution:
 *   1. Conditional/complex policies live in ACTION_POLICIES (predicates,
 *      conditional preflights, verify objects).
 *   2. Simple "always-approve" policies are declared via `requireApproval`
 *      decorators on the handler and derived at lookup time.
 *
 * `policyFor()` checks the central map first, then falls back to decorator
 * metadata. `protectAction()` wraps the handler with HITL once the policy
 * is resolved.
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

// ---------------------------------------------------------------------------
// Predicates (shared by conditional policies)
// ---------------------------------------------------------------------------

const always = (): boolean => true;
const actionIs = (...values: string[]): Predicate => (args) => values.includes(String(args.action));
const hasDangerousChatOperation = actionIs("delete", "clear");
const hasDangerousInviteOperation = actionIs("revoke", "join");
const hasDangerousContactOperation = actionIs("block", "unblock");
const mutatesLocalCollection = (args: Record<string, unknown>): boolean => !["get", "list", "list_by_tag"].includes(String(args.action));

// ---------------------------------------------------------------------------
// Preflight guards (used by conditional policies)
// ---------------------------------------------------------------------------

const requireStoreMessage: Preflight = (args, context) =>
  context.store.getMessage(String(args.message_id))
    ? null
    : `Message ${String(args.message_id)} is not present in the local store; refusing a destructive review without a preflighted target.`;
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

// ---------------------------------------------------------------------------
// Verify helpers (used by conditional policies)
// ---------------------------------------------------------------------------

const verifyContactTags: Verify = (args, context) => {
  const jid = String(args.jid).includes("@") ? String(args.jid) : `${String(args.jid)}@s.whatsapp.net`;
  return {
    method: "local Store read-back",
    checked: ["contact_tags"],
    actual: context.store.getContactTags(jid),
    ok: true,
  };
};

// ---------------------------------------------------------------------------
// Conditional policies — central map (only cases that can't use decorators)
// ---------------------------------------------------------------------------

/** Conditional/complex policies that require predicates, conditional preflights, or verify objects. */
export const ACTION_POLICIES: Record<string, ActionPolicy> = {
  "chat-manage": { approval: always, preflight: (args, context) => hasDangerousChatOperation(args) ? requireChat(args, context) : null, identityFields: ["jid"], lockIdentity: hasDangerousChatOperation },
  "contact-block": { approval: hasDangerousContactOperation },
  "group-invite": { approval: hasDangerousInviteOperation, preflight: (args, context) => String(args.action) === "revoke" ? requireGroup(args, context) : null, identityFields: ["jid"], lockIdentity: actionIs("revoke") },
  "profile-name": { approval: actionIs("edit") },
  "profile-about": { approval: actionIs("edit") },
  "profile-picture": { approval: (args) => String(args.action) === "edit" || String(args.action) === "remove" },
  "profile-privacy": { approval: actionIs("set") },
  "contact-tags": { approval: mutatesLocalCollection, verify: verifyContactTags },
};

// ---------------------------------------------------------------------------
// Decorator-based policy derivation
// ---------------------------------------------------------------------------

/**
 * Derive an ActionPolicy from handler decorator metadata.
 *
 * Looks for `__require_approval__`, `__preflight_check__`, and
 * `__require_verification__` properties set by the decorators in
 * `decorators.ts`.
 *
 * Throw-based preflight guards (from `requirePreflight`) are wrapped to
 * return-string style for `protectAction` compatibility.
 */
function derivePolicyFromDecorators(def: ActionDef): ActionPolicy | undefined {
  const handler = def.handler as any;
  if (!handler.__require_approval__) return undefined;
  const policy: ActionPolicy = { approval: true };
  if (handler.__preflight_check__) {
    const rawCheck = handler.__preflight_check__ as (args: Record<string, unknown>, ctx: Record<string, unknown>) => void | never;
    // Wrap throw-based preflight to return-string style for protectAction
    policy.preflight = async (args, context) => {
      try {
        await rawCheck(args, context as unknown as Record<string, unknown>);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    };
    policy.identityFields = handler.__preflight_identity_fields__;
  }
  if (handler.__require_verification__) {
    policy.verify = handler.__verification_checks__;
  }
  return policy;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the declared policy for one registered action.
 *
 * Resolution order:
 *   1. Central map (conditional/complex policies)
 *   2. Handler decorator metadata (simple always-approve)
 *   3. undefined (read-only action)
 *
 * Args:
 *   name: Kebab-case action name from the registry.
 *   def: Optional ActionDef to inspect for decorator metadata.
 *
 * Returns:
 *   The action policy, or undefined when the action is read-only.
 *
 * Examples:
 *   policyFor("send-text", registry["send-text"])?.approval
 *   // => true
 *   policyFor("chat-manage", registry["chat-manage"])?.approval
 *   // => [Function: always]
 *   policyFor("chat-list")
 *   // => undefined
 */
export function policyFor(name: string, def?: ActionDef): ActionPolicy | undefined {
  // 1. Central map — conditional/complex cases take precedence
  if (ACTION_POLICIES[name]) return ACTION_POLICIES[name];
  // 2. Derive from handler decorators
  if (def) return derivePolicyFromDecorators(def);
  return undefined;
}

/**
 * Attach declared preflight, approval, and verification behavior to one action.
 *
 * Args:
 *   definition: Registry action definition to protect.
 *   policy: Optional policy from policyFor().
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
  const protectedHandler: ActionHandler = async (args, context) => {
      // Zod payload validation (safety net — before HITL).
      if (definition.schema) {
        const result = definition.schema.safeParse(args);
        if (!result.success) {
          return errResult(`Payload validation failed: ${result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
        }
        args = result.data;
      }
      const needsApproval = typeof policy.approval === "function" ? policy.approval(args) : policy.approval;

      // Pre-check: verify referenced message exists in store before opening HITL
      const refActions = ["edit-message", "delete-message", "send-reaction", "forward-message"];
      if (refActions.includes(definition.meta.action) && needsApproval && context.store) {
        const mid = String(args.message_id || args.from_message_id || "");
        if (mid && !context.store.getMessage(mid)) {
          return errResult(`Message not found in local store: ${mid}. Cannot open HITL for a message that doesn't exist.`);
        }
      }

      if (needsApproval && policy.preflight) {
        const error = await policy.preflight(args, context);
        if (error) return errResult(error);
      }
      let approvedArgs = args;
      if (needsApproval) {
        const isMessageAction = ["send-text", "send-image", "send-video", "send-audio", "send-document", "send-sticker", "send-location", "send-contact", "send-poll", "send-reaction", "edit-message", "forward-message", "send-batch"].includes(definition.meta.action);
        const review = await requestApproval(definition.meta.action, args, { reviewMode: isMessageAction ? "message" : "default", store: context.store });
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
          // Inject HITL traceability into data
          const data = output.data as Record<string, unknown>;
          data._hitl = {
            original: args,
            approved: approvedArgs,
            edited: review.edited,
            comment: review.comment,
          };
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
  };
  // Copy decorator metadata from original handler to protected handler
  const src = original as any;
  if (src.__require_approval__) (protectedHandler as any).__require_approval__ = src.__require_approval__;
  if (src.__review_mode__) (protectedHandler as any).__review_mode__ = src.__review_mode__;
  if (src.__preflight_check__) (protectedHandler as any).__preflight_check__ = src.__preflight_check__;
  if (src.__preflight_identity_fields__) (protectedHandler as any).__preflight_identity_fields__ = src.__preflight_identity_fields__;
  if (src.__require_verification__) (protectedHandler as any).__require_verification__ = src.__require_verification__;
  if (src.__verification_checks__) (protectedHandler as any).__verification_checks__ = src.__verification_checks__;
  return {
    ...definition,
    handler: protectedHandler,
  };
}
