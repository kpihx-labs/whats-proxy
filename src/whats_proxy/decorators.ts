/**
 * Action framework — declarative approval, review, and verification policies.
 *
 * Port of tick-proxy's `actions/base.py` to TypeScript/Bun.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReviewMode = "default" | "message";

export type Preflight = (
  args: Record<string, unknown>,
  context: Record<string, unknown>,
) => void | never;

export interface Verification {
  method: string;
  checked: string[];
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
  ok: boolean;
}

export interface ActionDef {
  name: string;
  handler: Function;
  hitl: boolean;
  reviewMode: ReviewMode;
  preflightCheck: Preflight | null;
  identityFields: string[];
  requireVerification: boolean;
  verificationChecks: string[];
  group: string;
}

// ---------------------------------------------------------------------------
// Decorator metadata keys (well-known symbols / property names)
// ---------------------------------------------------------------------------

const META = {
  requireApproval: "__require_approval__",
  reviewMode: "__review_mode__",
  preflightCheck: "__preflight_check__",
  preflightIdentityFields: "__preflight_identity_fields__",
  requireVerification: "__require_verification__",
  verificationChecks: "__verification_checks__",
} as const;

// ---------------------------------------------------------------------------
// Decorator factories
// ---------------------------------------------------------------------------

/**
 * Declare a handler's mandatory HITL review policy.
 *
 * @param reviewMode - `"message"` for structured WhatsApp message review,
 *   `"default"` for the shared full-JSON review.
 * @returns A decorator carrying auditable review metadata.
 */
export function requireApproval(reviewMode: ReviewMode = "default") {
  return function <T extends Function>(handler: T): T {
    const wrapper = function (this: unknown, ...args: unknown[]) {
      return (handler as Function).apply(this, args);
    };
    // Preserve name and copy over any existing properties
    Object.defineProperty(wrapper, "name", { value: handler.name, configurable: true });
    Object.assign(wrapper, handler);

    // Set metadata
    (wrapper as any)[META.requireApproval] = true;
    (wrapper as any)[META.reviewMode] = reviewMode;

    return wrapper as unknown as T;
  };
}

/**
 * Require a resource-safety read before HITL and lock its identity in review.
 *
 * @param check - Read-only guard that throws when the resource is not safe.
 * @param identityFields - Payload fields that identify the reviewed target
 *   and cannot change between preflight and approval.
 * @returns A decorator that declares the preflight and identity policy.
 */
export function requirePreflight(
  check: Preflight,
  identityFields: string[],
) {
  return function <T extends Function>(handler: T): T {
    const wrapper = function (this: unknown, ...args: unknown[]) {
      return (handler as Function).apply(this, args);
    };
    Object.defineProperty(wrapper, "name", { value: handler.name, configurable: true });
    Object.assign(wrapper, handler);

    (wrapper as any)[META.preflightCheck] = check;
    (wrapper as any)[META.preflightIdentityFields] = identityFields;

    return wrapper as unknown as T;
  };
}

/**
 * Declare fields a write must read back and compare before returning.
 *
 * @param checks - Field names the handler must compare, e.g. `"jid"`, `"messageId"`.
 * @returns A decorator that marks the handler as requiring post-write verification.
 */
export function requireVerification(...checks: string[]) {
  return function <T extends Function>(handler: T): T {
    const wrapper = function (this: unknown, ...args: unknown[]) {
      return (handler as Function).apply(this, args);
    };
    Object.defineProperty(wrapper, "name", { value: handler.name, configurable: true });
    Object.assign(wrapper, handler);

    (wrapper as any)[META.requireVerification] = true;
    (wrapper as any)[META.verificationChecks] = checks;

    return wrapper as unknown as T;
  };
}

// ---------------------------------------------------------------------------
// actionDef() — build ActionDef from decorator metadata
// ---------------------------------------------------------------------------

/**
 * Build an action definition from visible handler decorators.
 *
 * @param name - Flat registered action name.
 * @param handler - Decorated implementation.
 * @param opts - Optional: group (catalog group for help).
 * @returns ActionDef with hitl, reviewMode, preflight, identityFields derived
 *   from decorators.
 */
export function actionDef(
  name: string,
  handler: Function,
  opts?: { group?: string },
): ActionDef {
  const reviewMode = ((handler as any)[META.reviewMode] ?? "default") as ReviewMode;
  if (reviewMode !== "default" && reviewMode !== "message") {
    throw new Error(`${name} declares unsupported review mode: ${String(reviewMode)}`);
  }
  return {
    name,
    handler,
    hitl: Boolean((handler as any)[META.requireApproval]),
    reviewMode,
    preflightCheck: (handler as any)[META.preflightCheck] ?? null,
    identityFields: (handler as any)[META.preflightIdentityFields] ?? [],
    requireVerification: Boolean((handler as any)[META.requireVerification]),
    verificationChecks: (handler as any)[META.verificationChecks] ?? [],
    group: opts?.group ?? "Misc",
  };
}

// ---------------------------------------------------------------------------
// compare() — build a Verification by comparing intended vs observed state
// ---------------------------------------------------------------------------

/**
 * Build a `Verification` by comparing the intended and observed states.
 *
 * @param method - The read-back performed, for the audit trail.
 * @param expected - What the caller asked for.
 * @param actual - What the server really holds.
 * @returns Verification with `ok=true` only when every expected key matches.
 */
export function compare(
  method: string,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): Verification {
  const checked = Object.keys(expected).sort();
  const ok = checked.every((k) => actual[k] === expected[k]);
  return {
    method,
    checked,
    expected,
    actual: Object.fromEntries(checked.map((k) => [k, actual[k]])),
    ok,
  };
}
