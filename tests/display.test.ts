/**
 * whats-proxy — unit tests: display (ASCII tables, stdout purity).
 */

import { describe, expect, test } from "bun:test";
import { print_table, output_result } from "../src/whats_proxy/display.ts";

function capture(fn: () => void): string {
  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => {
    out.push(String(s));
    return true;
  }) as never;
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return out.join("");
}

describe("print_table", () => {
  test("list of dicts → aligned table with header", () => {
    const text = capture(() =>
      print_table([
        { name: "alice", age: 30 },
        { name: "bob", age: 25 },
      ]),
    );
    expect(text).toContain("name");
    expect(text).toContain("alice");
    expect(text).toContain("|");
    expect(text).toContain("+");
  });

  test("empty list", () => {
    expect(capture(() => print_table([]))).toContain("(empty)");
  });

  test("dict → key/value rows", () => {
    const text = capture(() => print_table({ a: 1, b: "x" }));
    expect(text).toContain("a");
    expect(text).toContain("b");
  });
});

describe("output_result", () => {
  test("json format prints the whole envelope", () => {
    const result = { meta: { status: "ok" as const, comment: "", edited: false }, data: { x: 1 } };
    const text = capture(() => output_result(result, "json"));
    expect(text).toContain('"status": "ok"');
    expect(text).toContain('"x": 1');
  });

  test("table format prints Meta: and Data: blocks", () => {
    const result = { meta: { status: "ok" as const, comment: "", edited: false }, data: { x: 1 } };
    const text = capture(() => output_result(result, "table"));
    expect(text).toContain("Meta:");
    expect(text).toContain("Data:");
  });
});
