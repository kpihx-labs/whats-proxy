/**
 * whats-proxy — Logger.
 *
 * Writes to the state-dir log file (whats-proxy.log) AND stderr.
 * stdout is RESERVED for JSON output (envelope) — never log to stdout.
 * Level is configurable via config.logging.level.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 999,
};

export class Logger {
  private level: LogLevel;
  logFile: string | null;

  constructor(level: LogLevel = "info", logFile?: string) {
    this.level = level;
    this.logFile = logFile ?? null;
    if (this.logFile) {
      mkdirSync(dirname(this.logFile), { recursive: true });
    }
  }

  setLevel(level: LogLevel) {
    this.level = level;
  }

  private enabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  private write(level: LogLevel, msg: string) {
    if (!this.enabled(level)) return;
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;

    // stderr only (stdout stays pure JSON)
    process.stderr.write(line + "\n");

    // File (append, rotates by being truncated on daemon start)
    if (this.logFile) {
      try {
        appendFileSync(this.logFile, line + "\n", "utf-8");
      } catch {
        /* logging must never crash the process */
      }
    }
  }

  debug(msg: string) { this.write("debug", msg); }
  info(msg: string) { this.write("info", msg); }
  warn(msg: string) { this.write("warn", msg); }
  error(msg: string) { this.write("error", msg); }
}

/** Truncate/rotate the log file (called on daemon start). */
export function rotateLogFile(file: string) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, "", "utf-8"); // touch
  } catch {
    /* ignore */
  }
}

export function defaultLogFile(stateDir: string): string {
  return join(stateDir, "whats-proxy.log");
}

export const logger = new Logger();
