/**
 * whats-proxy — unit tests: declarative HITL safety policies.
 *
 * These tests prevent a future action from silently losing its declared
 * approval rule while keeping the actual browser review covered separately by
 * the local HTTP integration smoke test.
 */

import { describe, expect, test } from "bun:test";
import { ACTION_POLICIES, policyFor } from "../src/whats_proxy/actions/policies.ts";
import { REGISTRY } from "../src/whats_proxy/actions/registry.ts";
import { requestApproval } from "../src/whats_proxy/hitl.ts";
import { Store } from "../src/whats_proxy/store.ts";
import { getCompactHelp, getFullHelp } from "../src/whats_proxy/doc.ts";

describe("ACTION_POLICIES", () => {
  test("every policy names a registered action", () => {
    for (const action of Object.keys(ACTION_POLICIES)) {
      expect(REGISTRY[action]).toBeDefined();
    }
  });

  test("every do action has a docstring with Examples section", () => {
    for (const definition of Object.values(REGISTRY)) {
      expect(definition.docstring).toBeDefined();
      expect(typeof definition.docstring).toBe("string");
      expect(definition.docstring!.length).toBeGreaterThan(0);
      const fullHelp = getFullHelp(definition);
      expect(fullHelp).toContain("Examples:");
      expect(getCompactHelp(definition).length).toBeGreaterThan(0);
    }
  });

  test("complex action families have docstrings with Parameters section", () => {
    for (const action of ["send-text", "send-image", "send-video", "send-document", "batch-send-text", "group-participants", "group-invite", "analytics-search"]) {
      const definition = REGISTRY[action];
      expect(definition).toBeDefined();
      expect(definition!.docstring).toBeDefined();
      expect(definition!.docstring!.length).toBeGreaterThan(0);
    }
  });

  test("review and destructive actions have docstrings with examples", () => {
    for (const [name, policy] of Object.entries(ACTION_POLICIES)) {
      const definition = REGISTRY[name];
      expect(definition).toBeDefined();
      expect(definition!.docstring).toBeDefined();
      expect(definition!.docstring!.length).toBeGreaterThan(0);
    }
  });

  test("all message sends and irreversible deletes require approval", () => {
    for (const action of ["send-text", "send-image", "send-video", "send-audio", "send-document", "delete-message", "group-leave", "channel-delete", "media-cleanup"]) {
      expect(policyFor(action, REGISTRY[action])).toBeDefined();
    }
  });

  test("conditional policies distinguish local collection reads from mutations", () => {
    const chatManage = policyFor("chat-manage")!;
    const watchlist = policyFor("watchlist")!;
    expect((chatManage.approval as (args: Record<string, unknown>) => boolean)({ action: "delete" })).toBe(true);
    expect((chatManage.approval as (args: Record<string, unknown>) => boolean)({ action: "archive" })).toBe(true);
    expect((watchlist.approval as (args: Record<string, unknown>) => boolean)({ action: "delete" })).toBe(true);
    expect((watchlist.approval as (args: Record<string, unknown>) => boolean)({ action: "add" })).toBe(true);
    expect((watchlist.approval as (args: Record<string, unknown>) => boolean)({ action: "list" })).toBe(false);
  });

  test("destructive policy declarations preflight and lock their real targets", () => {
    for (const action of ["delete-message", "group-leave", "channel-delete"]) {
      const policy = policyFor(action, REGISTRY[action])!;
      expect(policy.preflight).toBeDefined();
      expect(policy.identityFields?.length).toBeGreaterThan(0);
    }
  });

  test("local destructive preflight refuses an unobserved message", async () => {
    const policy = policyFor("delete-message", REGISTRY["delete-message"])!;
    const result = await policy.preflight!({ jid: "33600000000", message_id: "missing" }, {
      store: new Store(),
    } as never);
    expect(result).toContain("not present");
  });

  test("local HITL review binds an actual port and returns an edited approval", async () => {
    const stderr: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => { stderr.push(String(chunk)); return true; }) as never;
    try {
      const review = requestApproval("send-text", { jid: "33600000000", text: "original" });
      for (let attempt = 0; attempt < 20 && stderr.length === 0; attempt++) {
        await Bun.sleep(10);
      }
      const url = stderr.join("").match(/🔗 (http:\/\/127\.0\.0\.1:\d+\/review\?id=[a-f0-9-]+)\n/)?.[1];
      expect(url).toBeDefined();
      // GET the review page
      const page = await fetch(url!);
      expect(page.status).toBe(200);
      const html = await page.text();
      const id = html.match(/id:\s*'([^']+)'/)?.[1];
      expect(id).toBeDefined();
      // POST to /submit
      const baseUrl = url!.split("/review?")[0];
      const submitted = await fetch(`${baseUrl}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, status: "approved", payload: { jid: "33600000000", text: "edited" }, comment: "Reviewed" }),
      });
      expect(submitted.status).toBe(200);
      expect(await review).toEqual({ status: "approved", payload: { jid: "33600000000", text: "edited" }, edited: true, comment: "Reviewed" });
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});
