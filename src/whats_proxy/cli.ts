/**
 * whats-proxy — CLI dispatch.
 *
 * Mirrors tick-proxy: `main` → `do` (65 RPC actions) + `admin`
 * (setup/status, ALWAYS JSON) + hidden `daemon` command (used by the
 * auto-spawn path). Hand-rolled argv parsing — no CLI framework dependency,
 * while retaining the Bun/Baileys daemon required by WhatsApp state.
 *
 *   whats-proxy do <action> [payload|file] [-o file] [-f json|table] [-h]
 *   whats-proxy admin setup [--code] [--phone N]
 *   whats-proxy admin status
 *   whats-proxy admin stop
 *   whats-proxy --version
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

import { loadConfig } from "./config.ts";
import { logger } from "./logger.ts";
import { print_json, output_result, print_error } from "./display.ts";
import { getCompactHelp, getActionHelp } from "./doc.ts";
import { WhatsProxyError } from "./exceptions.ts";
import { REGISTRY } from "./actions/registry.ts";
import { validateRequiredArguments } from "./actions/types.ts";
import WaClient from "./client.ts";
import type { Output } from "./types.ts";
import { VERSION } from "./version.ts";

// ── Payload parsing ──────────────────────────────────────────────────────────

/** Convert a JSON string or file path to a dict (ts_proxy style RPC). */
function parsePayload(payload: string | undefined): Record<string, unknown> {
  if (!payload) return {};
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    // Not JSON → try file path
    if (existsSync(payload)) {
       const raw = readFileSync(payload, "utf-8");
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
        return { value: parsed };
      } catch {
        throw new WhatsProxyError(`Invalid JSON in file: ${payload}`, "PAYLOAD_INVALID");
      }
    }
    throw new WhatsProxyError(`Invalid JSON or file not found: ${payload}`, "PAYLOAD_INVALID");
  }
}

// ── Autosave ─────────────────────────────────────────────────────────────────

const AUTOSAVE_DIR = join(process.env.TMPDIR || "/tmp", "whats-proxy-autosave");

function writeJson(path: string, data: Output) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/** Centralized output handling for every `do` execution. */
function writeAndDisplay(
  result: Output,
  outputFile: string | undefined,
  fmt: "json" | "table",
  actionName: string,
) {
  mkdirSync(AUTOSAVE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
  const autosavePath = join(AUTOSAVE_DIR, `${actionName}_${stamp}.json`);
  try {
    writeJson(autosavePath, result);
  } catch {
    /* autosave must never break the command */
  }

  if (outputFile) {
    writeJson(outputFile, result);
    logger.info(`Written to: ${outputFile}`);
  } else {
    logger.info(`Autosave: ${autosavePath}`);
  }

  output_result(result, fmt);
}

// ── `do` command ─────────────────────────────────────────────────────────────

async function cmdDo(argv: string[]): Promise<number> {
  // Parse: do <action> [payload|file] [-o file] [-f fmt] [-h]
  let action: string | undefined;
  let payload: string | undefined;
  let outputFile: string | undefined;
  let fmt: "json" | "table" = "json";
  let fmtExplicit = false;
  let help = false;

  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift()!;
    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "-o" || arg === "--output-file") {
      const v = rest.shift();
      if (!v || v.startsWith("-")) {
        print_error(`Option ${arg} requires a file path.`);
        return 2;
      }
      outputFile = v;
    } else if (arg === "-f" || arg === "--format") {
      const v = rest.shift();
      if (!v || v.startsWith("-")) {
        print_error(`Option ${arg} requires a format (json|table).`);
        return 2;
      }
      fmt = v === "table" ? "table" : "json";
      fmtExplicit = true;
    } else if (arg.startsWith("-")) {
      print_error(`Unknown option: ${arg}`);
      return 2;
    } else if (!action) {
      action = arg;
    } else if (!payload) {
      payload = arg;
    } else {
      print_error(`Too many arguments: ${arg}`);
      return 2;
    }
  }

  // No action / --help at the `do` level → compact catalog help
  if (!action || help) {
    if (action && help) {
      if (fmtExplicit && fmt === "json") {
        // Machine-readable help (-h -f json): the registry meta IS the schema.
        const def = REGISTRY[action];
        process.stdout.write(
          JSON.stringify(
            {
              meta: { status: def ? "ok" : "error", comment: "", edited: false },
              data: def
                ? {
                    action: def.meta.action,
                    category: def.meta.category,
                    description: def.meta.description,
                    arguments: def.meta.arguments,
                    example: def.meta.example,
                    returns: def.meta.returns,
                  }
                : { error: `Unknown action: ${action}.` },
            },
            null,
            2,
          ) + "\n",
        );
      } else {
        process.stdout.write(getActionHelp(action, REGISTRY) + "\n");
      }
      return 0;
    }
    process.stdout.write(
      "For detailed information and examples on a specific action, run:\n" +
        "  whats-proxy do <action> --help\n\n",
    );
    process.stdout.write(getCompactHelp(REGISTRY) + "\n");
    return 0;
  }

  // Unknown action → error envelope + exit 1 (catalog hint)
  if (!REGISTRY[action]) {
    const output: Output = {
      meta: { status: "error", comment: `Unknown action: ${action}.`, edited: false },
      data: {
        error: `Unknown action: ${action}.`,
        hint: "Run 'whats-proxy do --help' for the full catalog.",
      },
    };
    writeAndDisplay(output, outputFile, fmt, action);
    return 1;
  }

  // Validate payload
  let args: Record<string, unknown> = {};
  try {
    args = parsePayload(payload);
  } catch (err) {
    const output: Output = {
      meta: { status: "error", comment: (err as Error).message, edited: false },
      data: { error: (err as Error).message },
    };
    writeAndDisplay(output, outputFile, fmt, action);
    return 1;
  }

  const definition = REGISTRY[action];
  if (!definition) {
    throw new Error(`Registry lost validated action: ${action}`);
  }

  // Required-argument check first (clear "Missing required argument(s): X, Y" message).
  const validationError = validateRequiredArguments(definition, args);
  if (validationError) {
    const output: Output = {
      meta: { status: "error", comment: validationError, edited: false },
      data: { error: validationError },
    };
    writeAndDisplay(output, outputFile, fmt, action);
    return 1;
  }

  // Zod payload validation (type safety net — catches wrong types after required check).
  if (definition.schema) {
    const result = definition.schema.safeParse(args);
    if (!result.success) {
      const error = `Payload validation failed: ${result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
      const output: Output = {
        meta: { status: "error", comment: error, edited: false },
        data: { error },
      };
      writeAndDisplay(output, outputFile, fmt, action);
      return 1;
    }
    args = result.data;
  }

  // Execute against the daemon (auto-spawns if needed)
  const client = new WaClient();
  try {
    const result = await client.do(action, args);
    writeAndDisplay(result, outputFile, fmt, action);
    return result.meta.status === "error" ? 1 : 0;
  } catch (err) {
    const output: Output = {
      meta: { status: "error", comment: (err as Error).message, edited: false },
      data: { error: (err as Error).message },
    };
    writeAndDisplay(output, outputFile, fmt, action);
    return 1;
  }
}

// ── `admin` commands ─────────────────────────────────────────────────────────

async function cmdAdmin(argv: string[]): Promise<number> {
  const sub = argv[0];

  // --help / -h at the admin level → show usage
  if (sub === "--help" || sub === "-h" || sub === undefined) {
    process.stdout.write(
      "Usage:\n" +
      "  whats-proxy admin setup [--code] [--phone N]  Pair WhatsApp (QR or code)\n" +
      "  whats-proxy admin status                      Daemon + auth status (JSON)\n" +
      "  whats-proxy admin stop                        Stop the daemon\n",
    );
    return 0;
  }

  // admin always returns JSON; reject --format/--output-file loudly
  if (argv.includes("--format") || argv.includes("-f") || argv.includes("--output-file") || argv.includes("-o")) {
    const output: Output = {
      meta: { status: "error", comment: "admin commands do not accept --format/--output-file.", edited: false },
      data: { error: "admin commands do not accept --format/--output-file." },
    };
    print_json(output);
    return 2;
  }

  switch (sub) {
    case "setup": {
      if (argv.includes("--help") || argv.includes("-h")) {
        process.stdout.write(
          "Usage:\n" +
          "  whats-proxy admin setup              QR code pairing (scan with phone)\n" +
          "  whats-proxy admin setup --code       Numeric pairing code (8 digits)\n" +
          "  whats-proxy admin setup --code --phone N  Pairing code for a specific number\n",
        );
        return 0;
      }
      const { adminSetup } = await import("./admin/setup.ts");
      const result = await adminSetup({
        code: argv.includes("--code"),
        phone: argv.includes("--phone") ? argv[argv.indexOf("--phone") + 1] : undefined,
      });
      print_json(result);
      return result.meta.status === "error" ? 1 : 0;
    }

    case "status": {
      const { adminStatus } = await import("./admin/status.ts");
      const result = await adminStatus();
      print_json(result);
      return result.meta.status === "error" ? 1 : 0;
    }

    case "stop": {
      const { adminStop } = await import("./admin/stop.ts");
      const result = await adminStop();
      print_json(result);
      return result.meta.status === "error" ? 1 : 0;
    }

    default:
      print_json({
        meta: { status: "error", comment: `Unknown admin subcommand: ${sub}`, edited: false },
        data: {
          error: `Unknown admin subcommand: ${sub}`,
          usage: "whats-proxy admin setup|status|stop",
        },
      } satisfies Output);
      return 2;
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;

   // Setup stderr-only logging; stdout stays pure JSON for automation.
  const cfg = loadConfig();
   logger.setLevel("info");

  switch (cmd) {
    case "do":
      return cmdDo(rest);
    case "admin":
      return cmdAdmin(rest);
    case "daemon": {
      const { startDaemon } = await import("./daemon.ts");
      await startDaemon();
      return 0; // daemon runs until SIGTERM
    }
    case "--version":
    case "-v":
      print_json({ meta: { status: "ok", comment: "", edited: false }, data: { version: VERSION } });
      return 0;
    default:
      process.stdout.write(
        `whats-proxy v${VERSION} — WhatsApp CLI proxy (non-MCP)\n\n` +
          `Usage:\n` +
          `  whats-proxy do <action> [payload|file] [-o file] [-f json|table]\n` +
          `  whats-proxy do --help          # full action catalog\n` +
          `  whats-proxy do <action> --help # per-action help\n` +
          `  whats-proxy admin setup [--code] [--phone N]\n` +
          `  whats-proxy admin status\n` +
          `  whats-proxy admin stop\n` +
          `  whats-proxy --version\n`,
      );
      return cmd === "--help" || cmd === "-h" || cmd === undefined ? 0 : 2;
  }
}
