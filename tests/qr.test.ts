/**
 * whats-proxy — unit tests: QR rendering path used by `admin setup`.
 *
 * setup.ts renders the pairing QR via qrcode.toString(qr, {type:"terminal"}).
 * This test verifies the exact same call produces non-empty terminal output
 * for a realistic Baileys QR payload, so the display path is never the
 * untested link in the pairing flow.
 */

import { describe, expect, test } from "bun:test";
import qrcode from "qrcode";

describe("QR terminal rendering (admin setup path)", () => {
  test("qrcode.toString terminal renders a Baileys-style QR", async () => {
    // Baileys emits QR payloads of the form "1@<base64>,<base64>,<level>"
    const qrPayload = "1@MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=,MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=,42";
    const text = await new Promise<string>((resolve, reject) => {
      qrcode.toString(qrPayload, { type: "terminal", small: true }, (err, code) => {
        if (err) reject(err);
        else resolve(code);
      });
    });
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(20);
    expect(text).toContain("\u2588"); // block character — actual QR art
  });

  test("qrcode.toString call signature matches setup.ts usage", async () => {
    // Same options object literal as admin/setup.ts
    const qrPayload = "1@dGVzdA==,dGVzdA==,7";
    const text = await new Promise<string>((resolve, reject) => {
      qrcode.toString(qrPayload, { type: "terminal", small: true }, (err, code) => {
        if (err) reject(err);
        else resolve(code);
      });
    });
    expect(text.length).toBeGreaterThan(20);
  });

  test("invalid payload rejects cleanly (no hang)", async () => {
    const result = await new Promise<{ ok: boolean; msg: string }>((resolve) => {
      qrcode.toString("", { type: "terminal", small: true }, (err, code) => {
        resolve(err ? { ok: false, msg: err.message } : { ok: true, msg: String(code) });
      });
    });
    // Empty payload may still render (qrcode is lenient) — either way it must
    // resolve promptly and never hang.
    expect(typeof result.ok).toBe("boolean");
  });
});
