import { describe, expect, test } from "bun:test";

import raw, { decodeRawValue, serializeRawValue } from "../src/whats_proxy/actions/raw.ts";

describe("raw Baileys action", () => {
  test("decodes binary JSON and serializes binary results", async () => {
    const source = Buffer.from("raw-bytes");
    expect(decodeRawValue({ $base64: source.toString("base64") })).toEqual(source);
    expect(await serializeRawValue(source)).toEqual({ $base64: source.toString("base64") });
  });

  test("invokes any callable socket method with socket binding", async () => {
    const sock = {
      prefix: "bound",
      inspect(this: { prefix: string }, value: Buffer) {
        return { value: `${this.prefix}:${value.toString()}` };
      },
    };
    const output = await raw[0]!.handler(
      { protocol: "baileys", target: "socket", method: "inspect", args: [{ $base64: Buffer.from("payload").toString("base64") }] },
      { sock: sock as never, store: {} as never, config: {} as never, connectionInfo: () => ({} as never), registry: {} },
    );

    expect(output.meta.status).toBe("ok");
    expect(output.data).toEqual({ protocol: "baileys", target: "socket", method: "inspect", result: { value: "bound:payload" } });
  });

  test("returns an envelope error for unavailable methods", async () => {
    const output = await raw[0]!.handler(
      { protocol: "baileys", target: "socket", method: "missing" },
      { sock: {} as never, store: {} as never, config: {} as never, connectionInfo: () => ({} as never), registry: {} },
    );

    expect(output.meta.status).toBe("error");
  });

  test("invokes Store methods and unrestricted SQL", async () => {
    const store = {
      getMessages: (jid: string, limit: number) => [{ jid, limit }],
      rawSql: (sql: string, params: unknown[]) => ({ sql, params }),
    };
    const context = { sock: {} as never, store: store as never, config: {} as never, connectionInfo: () => ({} as never), registry: {} };

    const methodOutput = await raw[0]!.handler({ protocol: "store", target: "method", method: "getMessages", args: ["chat@g.us", 3] }, context);
    const sqlOutput = await raw[0]!.handler({ protocol: "store", target: "sql", sql: "SELECT ?", params: [42] }, context);

    expect(methodOutput.data).toEqual({ protocol: "store", target: "method", method: "getMessages", result: [{ jid: "chat@g.us", limit: 3 }] });
    expect(sqlOutput.data).toEqual({ protocol: "store", target: "sql", sql: "SELECT ?", result: { sql: "SELECT ?", params: [42] } });
  });
});
