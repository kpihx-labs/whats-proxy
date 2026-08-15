/**
 * whats-proxy — Logger.
 *
 * Writes to stderr only. stdout is RESERVED for JSON output (envelope) and
 * file logging is deliberately excluded, matching the proxy standard.
 */

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

  /**
   * Create a stderr-only diagnostic logger.
   *
   * Args:
   *   level: Minimum severity emitted to stderr.
   *
   * Returns:
   *   A logger instance that never writes to stdout or a file.
   *
   * Examples:
   *   new Logger("silent").info("hidden")
   *   // => no output
   *   new Logger("info").error("connection failed")
   *   // => "[... ] [ERROR] connection failed" on stderr
   */
  constructor(level: LogLevel = "info") {
    this.level = level;
  }

  /**
   * Change the minimum stderr severity for subsequent messages.
   *
   * Args:
   *   level: Minimum severity to retain.
   *
   * Returns:
   *   Nothing; the logger state changes in place.
   *
   * Examples:
   *   const log = new Logger(); log.setLevel("error")
   *   // => subsequent info diagnostics are omitted
   *   const log = new Logger("silent"); log.setLevel("debug")
   *   // => debug diagnostics become visible
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * Decide whether a severity passes the configured threshold.
   *
   * Args:
   *   level: Severity being considered for emission.
   *
   * Returns:
   *   True when the message is eligible for stderr output.
   *
   * Examples:
   *   new Logger("warn").enabled("info")
   *   // => false
   *   new Logger("warn").enabled("error")
   *   // => true
   */
  private enabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  /**
   * Emit one formatted diagnostic to stderr when its severity is enabled.
   *
   * Args:
   *   level: Severity label displayed in the diagnostic prefix.
   *   msg: Human-readable diagnostic text.
   *
   * Returns:
   *   Nothing; stdout remains untouched for JSON envelopes.
   *
   * Examples:
   *   new Logger().write("info", "daemon started")
   *   // => "[... ] [INFO] daemon started" on stderr
   *   new Logger("error").write("debug", "details")
   *   // => no output
   */
  private write(level: LogLevel, msg: string): void {
    if (!this.enabled(level)) return;
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;

    // stderr only (stdout stays pure JSON)
    process.stderr.write(line + "\n");
  }

  /** Emit a debug diagnostic to stderr. Args: msg is the diagnostic text. Returns: nothing. Examples: logger.debug("retry 1") → stderr debug line; logger.debug("payload parsed") → stderr debug line. */
  debug(msg: string): void { this.write("debug", msg); }
  /** Emit an informational diagnostic to stderr. Args: msg is the diagnostic text. Returns: nothing. Examples: logger.info("daemon ready") → stderr info line; logger.info("QR received") → stderr info line. */
  info(msg: string): void { this.write("info", msg); }
  /** Emit a warning diagnostic to stderr. Args: msg is the diagnostic text. Returns: nothing. Examples: logger.warn("retrying") → stderr warning line; logger.warn("session expired") → stderr warning line. */
  warn(msg: string): void { this.write("warn", msg); }
  /** Emit an error diagnostic to stderr. Args: msg is the diagnostic text. Returns: nothing. Examples: logger.error("connection failed") → stderr error line; logger.error("invalid response") → stderr error line. */
  error(msg: string): void { this.write("error", msg); }
}

export const logger = new Logger();
