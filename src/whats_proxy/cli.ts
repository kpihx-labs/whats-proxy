/**
 * whats-proxy — CLI dispatch.
 *
 * Mirrors tick-proxy: `main` → `do` (65 RPC actions) + `admin`
 * (auth + daemon, ALWAYS JSON) + hidden `daemon` command (used by the
 * auto-spawn path). Hand-rolled argv parsing — no CLI framework dependency,
 * while retaining the Bun/Baileys daemon required by WhatsApp state.
 *
 * Multi-account: every command accepts `--account <phone>` (or `-a`) to
 * target a specific WhatsApp account. Resolution order:
 *   1. --account / -a <phone>   (explicit)
 *   2. WHATS_PROXY_ACCOUNT env  (test override)
 *   3. Default from accounts.json
 *   4. Error if none
 *
 *   whats-proxy do <action> [payload|file] [-a phone] [-o file] [-f json|table] [-h]
 *   whats-proxy admin auth login [--code] [--phone N]
 *   whats-proxy admin auth status [phone]
 *   whats-proxy admin auth logout <phone>
 *   whats-proxy admin auth use <phone>
 *   whats-proxy admin daemon status [phone]
 *   whats-proxy admin daemon stop [phone]
 *   whats-proxy admin daemon restart [phone]
 *   whats-proxy admin daemon logs [phone]
 *   whats-proxy admin daemon refresh [phone]
 *   whats-proxy daemon --account <phone>
 *   whats-proxy --version
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

import { loadConfig, migrateLegacyState, getDefaultAccount, canonicalPhone, type AppConfig } from "./config.ts";
import { logger } from "./logger.ts";
import { print_json, output_result, print_error } from "./display.ts";
import { getCompactHelp, getFullHelp, getCatalogHelp } from "./doc.ts";
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

// ── Account resolution ──────────────────────────────────────────────────────

/**
 * Resolve phone from explicit flag, env, or default. Returns null for legacy
 * flat layout when no accounts are registered.
 */
function resolveAccount(explicit?: string): string | null {
  // 1. Explicit --account / -a flag
  if (explicit) return canonicalPhone(explicit);

  // 2. Environment variable (test override)
  const envPhone = process.env.WHATS_PROXY_ACCOUNT;
  if (envPhone) return canonicalPhone(envPhone);

  // 3. Default account from accounts.json (null = legacy flat layout)
  return getDefaultAccount();
}

// ── `do` command ─────────────────────────────────────────────────────────────

async function cmdDo(argv: string[]): Promise<number> {
  // Parse: do [-a phone] <action> [payload|file] [-o file] [-f fmt] [-h]
  let account: string | undefined;
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
    } else if (arg === "-a" || arg === "--account") {
      const v = rest.shift();
      if (!v || v.startsWith("-")) {
        print_error(`Option ${arg} requires a phone number.`);
        return 2;
      }
      account = v;
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
        process.stdout.write(getFullHelp(REGISTRY[action]!) + "\n");
      }
      return 0;
    }
    process.stdout.write(
      "For detailed information and examples on a specific action, run:\n" +
        "  whats-proxy do <action> --help\n\n",
    );
    process.stdout.write(getCatalogHelp(REGISTRY) + "\n");
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

  // Resolve account and execute against the daemon (auto-spawns if needed)
  const resolvedPhone = resolveAccount(account);

  const client = new WaClient(resolvedPhone ?? undefined);
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

function deprecationWarn(old: string, replacement: string) {
  process.stderr.write(`⚠️  DEPRECATED: '${old}' is deprecated. Use '${replacement}' instead.\n`);
}

/** Parse --phone from argv (returns canonical digits or undefined). */
function extractPhone(argv: string[]): string | undefined {
  const idx = argv.indexOf("--phone");
  if (idx !== -1 && idx + 1 < argv.length) {
    return canonicalPhone(argv[idx + 1]!);
  }
  return undefined;
}

async function cmdAdmin(argv: string[]): Promise<number> {
  const sub = argv[0];

  // --help / -h at the admin level → show usage
  if (sub === "--help" || sub === "-h" || sub === undefined) {
    process.stdout.write(
      "Usage:\n" +
      "  whats-proxy admin auth login [--code] [--phone N]   Pair WhatsApp (QR or code)\n" +
      "  whats-proxy admin auth status [phone]               Auth status (JSON)\n" +
      "  whats-proxy admin auth logout <phone>                Logout & unregister\n" +
      "  whats-proxy admin auth use <phone>                   Set default account\n" +
      "  whats-proxy admin daemon status [phone]              Daemon status (JSON)\n" +
      "  whats-proxy admin daemon stop [phone]                Stop daemon\n" +
      "  whats-proxy admin daemon restart [phone]             Restart daemon\n" +
      "  whats-proxy admin daemon logs [phone]                Tail daemon logs\n" +
      "  whats-proxy admin daemon refresh [phone]             Refresh app state\n" +
      "\n" +
      "  Deprecated aliases (still work, emit warning):\n" +
      "    whats-proxy admin setup [--code] [--phone N]  → admin auth login\n" +
      "    whats-proxy admin status                      → admin daemon status\n" +
      "    whats-proxy admin stop                        → admin daemon stop\n",
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

  // ── New routing: admin auth | admin daemon ──────────────────────────────

  if (sub === "auth") {
    const subsub = argv[1];
    const rest = argv.slice(2);

    switch (subsub) {
      case "login": {
        if (rest.includes("--help") || rest.includes("-h")) {
          process.stdout.write(
            "Usage:\n" +
            "  whats-proxy admin auth login              QR code pairing (scan with phone)\n" +
            "  whats-proxy admin auth login --code       Numeric pairing code (8 digits)\n" +
            "  whats-proxy admin auth login --code --phone N  Pairing code for a specific number\n",
          );
          return 0;
        }
        const { authLogin } = await import("./admin/auth/login.ts");
        const result = await authLogin({
          code: rest.includes("--code"),
          phone: extractPhone(rest),
        });
        print_json(result);
        return result.meta.status === "error" ? 1 : 0;
      }

      case "status": {
        const phone = rest[0] ? canonicalPhone(rest[0]) : undefined;
        const { authStatus } = await import("./admin/auth/status.ts");
        const result = await authStatus({ phone });
        print_json(result);
        return result.meta.status === "error" ? 1 : 0;
      }

      case "logout": {
        if (!rest[0]) {
          print_json({
            meta: { status: "error", comment: "Usage: whats-proxy admin auth logout <phone>", edited: false },
            data: { error: "Missing required argument: phone" },
          } satisfies Output);
          return 2;
        }
        const { authLogout } = await import("./admin/auth/logout.ts");
        const result = await authLogout({ phone: canonicalPhone(rest[0]) });
        print_json(result);
        return result.meta.status === "error" ? 1 : 0;
      }

      case "use": {
        if (!rest[0]) {
          print_json({
            meta: { status: "error", comment: "Usage: whats-proxy admin auth use <phone>", edited: false },
            data: { error: "Missing required argument: phone" },
          } satisfies Output);
          return 2;
        }
        const { authUse } = await import("./admin/auth/use.ts");
        const result = await authUse({ phone: canonicalPhone(rest[0]) });
        print_json(result);
        return result.meta.status === "error" ? 1 : 0;
      }

      default:
        print_json({
          meta: { status: "error", comment: `Unknown admin auth subcommand: ${subsub ?? "(empty)"}`, edited: false },
          data: {
            error: `Unknown admin auth subcommand: ${subsub ?? "(empty)"}`,
            usage: "whats-proxy admin auth login|status|logout|use",
          },
        } satisfies Output);
        return 2;
    }
  }

  if (sub === "daemon") {
    const subsub = argv[1];
    const rest = argv.slice(2);
    const phone = rest[0] ? canonicalPhone(rest[0]) : undefined;

    switch (subsub) {
      case "status": {
        const { daemonStatus } = await import("./admin/daemon/status.ts");
        const result = await daemonStatus({ phone });
        print_json(result);
        return result.meta.status === "error" ? 1 : 0;
      }

      case "stop": {
        const { daemonStop } = await import("./admin/daemon/stop.ts");
        const result = await daemonStop({ phone });
        print_json(result);
        return result.meta.status === "error" ? 1 : 0;
      }

      case "restart": {
        const { daemonRestart } = await import("./admin/daemon/restart.ts");
        const result = await daemonRestart({ phone });
        print_json(result);
        return result.meta.status === "error" ? 1 : 0;
      }

      case "logs": {
        const { daemonLogs } = await import("./admin/daemon/logs.ts");
        const result = await daemonLogs({ phone });
        print_json(result);
        return result.meta.status === "error" ? 1 : 0;
      }

      case "refresh": {
        const { daemonRefresh } = await import("./admin/daemon/refresh.ts");
        const result = await daemonRefresh({ phone });
        print_json(result);
        return result.meta.status === "error" ? 1 : 0;
      }

      default:
        print_json({
          meta: { status: "error", comment: `Unknown admin daemon subcommand: ${subsub ?? "(empty)"}`, edited: false },
          data: {
            error: `Unknown admin daemon subcommand: ${subsub ?? "(empty)"}`,
            usage: "whats-proxy admin daemon status|stop|restart|logs|refresh [phone]",
          },
        } satisfies Output);
        return 2;
    }
  }

  // ── Backward compatibility aliases ──────────────────────────────────────

  if (sub === "setup") {
    deprecationWarn("admin setup", "admin auth login");
    if (argv.includes("--help") || argv.includes("-h")) {
      process.stdout.write(
        "Usage:\n" +
        "  whats-proxy admin setup              QR code pairing (scan with phone)\n" +
        "  whats-proxy admin setup --code       Numeric pairing code (8 digits)\n" +
        "  whats-proxy admin setup --code --phone N  Pairing code for a specific number\n",
      );
      return 0;
    }
    const { authLogin } = await import("./admin/auth/login.ts");
    const result = await authLogin({
      code: argv.includes("--code"),
      phone: extractPhone(argv),
    });
    print_json(result);
    return result.meta.status === "error" ? 1 : 0;
  }

  if (sub === "status") {
    deprecationWarn("admin status", "admin daemon status");
    const { adminStatus } = await import("./admin/status.ts");
    const result = await adminStatus();
    print_json(result);
    return result.meta.status === "error" ? 1 : 0;
  }

  if (sub === "stop") {
    deprecationWarn("admin stop", "admin daemon stop");
    const { adminStop } = await import("./admin/stop.ts");
    const result = await adminStop();
    print_json(result);
    return result.meta.status === "error" ? 1 : 0;
  }

  // Unknown admin subcommand
  print_json({
    meta: { status: "error", comment: `Unknown admin subcommand: ${sub}`, edited: false },
    data: {
      error: `Unknown admin subcommand: ${sub}`,
      usage: "whats-proxy admin auth|daemon  (or: setup|status|stop — deprecated)",
    },
  } satisfies Output);
  return 2;
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  // Auto-migrate legacy flat state to per-account layout (idempotent).
  try {
    migrateLegacyState();
  } catch {
    // Migration failure is non-fatal — old layout still works via legacy paths.
  }

  // Setup stderr-only logging; stdout stays pure JSON for automation.
  const cfg = loadConfig();
  logger.setLevel("info");

  switch (cmd) {
    case "do":
      return cmdDo(rest);
    case "admin":
      return cmdAdmin(rest);
    case "daemon": {
      // Parse --account from daemon args
      let phone: string | undefined;
      const daemonRest = [...rest];
      while (daemonRest.length > 0) {
        const arg = daemonRest.shift()!;
        if (arg === "--account" || arg === "-a") {
          const v = daemonRest.shift();
          if (v) phone = canonicalPhone(v);
        }
      }
      const { startDaemon } = await import("./daemon.ts");
      await startDaemon(phone);
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
          `  whats-proxy do <action> [payload|file] [-a phone] [-o file] [-f json|table]\n` +
          `  whats-proxy do --help          # full action catalog\n` +
          `  whats-proxy do <action> --help # per-action help\n` +
          `  whats-proxy admin auth login [--code] [--phone N]\n` +
          `  whats-proxy admin auth status [phone]\n` +
          `  whats-proxy admin auth logout <phone>\n` +
          `  whats-proxy admin auth use <phone>\n` +
          `  whats-proxy admin daemon status|stop|restart|logs|refresh [phone]\n` +
          `  whats-proxy daemon --account <phone>\n` +
          `  whats-proxy --version\n`,
      );
      return cmd === "--help" || cmd === "-h" || cmd === undefined ? 0 : 2;
  }
}
