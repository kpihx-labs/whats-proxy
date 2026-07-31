/**
 * whats-proxy — Error model.
 *
 * Single error type for the whole codebase. `code` is a stable
 * machine-readable identifier (e.g. "WA_NOT_CONNECTED", "PAYLOAD_INVALID")
 * that survives the JSON-RPC round-trip.
 */

export class WhatsProxyError extends Error {
  code: string;

  constructor(message: string, code = "WP_ERROR") {
    super(message);
    this.name = "WhatsProxyError";
    this.code = code;
  }
}
