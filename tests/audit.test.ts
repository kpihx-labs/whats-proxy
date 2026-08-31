/**
 * whats-proxy — Registration audit + Registry ↔ policies coherence.
 *
 * P2: Registration-time invariants (count, naming, meta consistency, examples).
 * P6: Registry ↔ policies bidirectional coherence.
 *
 * NOTE: Some P2/P6 checks overlap with policies.test.ts (policy→registry
 * lookup, ≥3 examples, help "Examples:" section). Those are intentionally
 * kept in policies.test.ts as the primary safety-policy test file. This
 * file covers the orthogonal invariants: registry structure, naming
 * conventions, meta.action consistency, and the inverse registry→policy
 * direction.
 */

import { describe, expect, test } from "bun:test";
import { REGISTRY, ACTION_COUNT, ALL } from "../src/whats_proxy/actions/registry.ts";
import { ACTION_POLICIES } from "../src/whats_proxy/actions/policies.ts";
import { SCHEMAS } from "../src/whats_proxy/actions/schemas.ts";
import { getCompactHelp, getFullHelp } from "../src/whats_proxy/doc.ts";

// ── P2: Registration audit ──────────────────────────────────────────────────

describe("Registration audit", () => {
  test("all 66 actions registered with correct count", () => {
    expect(ACTION_COUNT).toBe(66);
    expect(Object.keys(REGISTRY).length).toBe(66);
  });

  test("all action names are kebab-case", () => {
    for (const name of Object.keys(REGISTRY)) {
      expect(name).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    }
  });

  test("every action meta.action matches its registry key", () => {
    for (const [name, def] of Object.entries(REGISTRY)) {
      expect(def.meta.action).toBe(name);
    }
  });

  test("every action has a non-empty docstring", () => {
    for (const definition of Object.values(REGISTRY)) {
      expect(definition.docstring).toBeDefined();
      expect(typeof definition.docstring).toBe("string");
      expect(definition.docstring!.length).toBeGreaterThan(0);
    }
  });

  test("every action help contains Examples section", () => {
    for (const name of Object.keys(REGISTRY)) {
      const help = getFullHelp(REGISTRY[name]!);
      expect(help).toContain("Examples:");
    }
  });

  test("actions with arguments have Parameters section in help", () => {
    for (const [name, def] of Object.entries(REGISTRY)) {
      if (def.meta.arguments.length > 0) {
        const help = getFullHelp(def);
        expect(help).toContain("Parameters:");
      }
    }
  });
});

// ── P6: Registry ↔ policies coherence ───────────────────────────────────────

describe("Registry ↔ policies coherence", () => {
  test("every policy key references a registered action", () => {
    for (const action of Object.keys(ACTION_POLICIES)) {
      expect(REGISTRY[action]).toBeDefined();
    }
  });

  test("every registered action with side effects has a policy", () => {
    // Pure read-only actions — no approval/policy needed.
    // Keep sorted; add new read-only actions here when registered.
    const readOnly = new Set([
      // chats
      "chat-list", "chat-read",
      // contacts
      "contact-check", "contact-info", "contact-picture", "contact-business", "contact-list",
      // groups
      "group-info", "group-list",
      // channels
      "channel-info",
      // analytics (all pure reads)
      "analytics-overview", "analytics-top-chats", "analytics-chat-insights",
      "analytics-timeline", "analytics-search",
      // overview / digest (all pure reads)
      "whatsup", "find-messages", "messages-multi", "daily-digest",
      // utilities (pure reads)
      "connection-status", "guide", "search-messages",
    ]);
    for (const name of Object.keys(REGISTRY)) {
      if (!readOnly.has(name)) {
        expect(ACTION_POLICIES[name]).toBeDefined();
      }
    }
  });
});

// ── Zod schema completeness ────────────────────────────────────────────────

describe("Zod schema completeness", () => {
  test("SCHEMAS map has an entry for every registered action", () => {
    for (const name of Object.keys(REGISTRY)) {
      expect(SCHEMAS[name]).toBeDefined();
    }
    expect(Object.keys(SCHEMAS).length).toBe(Object.keys(REGISTRY).length);
  });

  test("every ActionDef.schema matches its SCHEMAS entry", () => {
    for (const [name, def] of Object.entries(REGISTRY)) {
      expect(def.schema).toBeDefined();
      expect(SCHEMAS[name]).toBeDefined();
      // Same object reference — schemas are shared, not duplicated.
      if (def.schema && SCHEMAS[name]) {
        expect(def.schema === SCHEMAS[name]).toBe(true);
      }
    }
  });

  test("schema keys match meta.arguments names", () => {
    for (const [name, def] of Object.entries(REGISTRY)) {
      const schema = SCHEMAS[name];
      expect(schema).toBeDefined();
      const schemaKeys = new Set(Object.keys(schema!.shape));
      for (const arg of def.meta.arguments) {
        expect(schemaKeys.has(arg.name)).toBe(true);
      }
    }
  });
});
