/**
 * Human-in-the-loop review for potentially consequential WhatsApp actions.
 *
 * Template-based HITL — ported from tick-proxy's hitl.py. Reads HTML
 * templates from the `templates/` directory, replaces placeholders, and
 * serves them via a local HTTP server on an OS-assigned free port.
 *
 * Server lifecycle: bind port 0 → serve template on GET /review?id=<uuid>
 * → collect decision on POST /submit → block until decision or timeout.
 *
 * 100% Web UI — no TUI fallback. If no browser, the URL is printed for
 * SSH access via `WHATS_PROXY_NO_BROWSER` guard.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exec as execCb } from "node:child_process";

export interface HITLResponse {
  /** `approved` after a reviewer accepts, otherwise `rejected`. */
  status: "approved" | "rejected";
  /** The reviewed payload, or null when rejected or timed out. */
  payload: Record<string, unknown> | null;
  /** Whether the reviewer submitted JSON different from the original. */
  edited: boolean;
  /** Optional reviewer rationale. */
  comment: string;
}

const TIMEOUT_MS = 600_000;

// ── Template paths ──────────────────────────────────────────────────────────

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "templates");
const TEMPLATE_PATH = join(TEMPLATES_DIR, "hitl.html");
const MESSAGE_TEMPLATE_PATH = join(TEMPLATES_DIR, "message-review.html");
const STYLESHEET_PATH = join(TEMPLATES_DIR, "hitl.css");

// ── Template rendering ──────────────────────────────────────────────────────

/**
 * Fill the HTML template with the payload under review.
 *
 * Args:
 *   templatePath: Path to the HTML template file.
 *   requestId: The review request UUID.
 *   action: Action name shown in the form heading.
 *   payload: Original validated JSON object placed in the editable editor.
 *
 * Returns:
 *   The rendered HTML page, or an error page if the template is missing.
 */
function renderTemplate(
  templatePath: string,
  requestId: string,
  action: string,
  payload: Record<string, unknown>,
  referencedMsg?: Record<string, unknown> | null,
  resolvedNames?: Record<string, string>,
): string {
  // Add referenced message data if available
  let refMsgDisplay = "";
  if (referencedMsg) {
    // Always pass the FULL message as JSON — let the template JS extract text
    refMsgDisplay = JSON.stringify(referencedMsg, null, 2);
  }

  let payloadDisplay: string;
  try {
    payloadDisplay = JSON.stringify(payload, null, 2);
  } catch {
    payloadDisplay = String(payload);
  }

  let html: string;
  try {
    html = readFileSync(templatePath, "utf-8");
  } catch {
    return `<!doctype html><html><body><h2>Template not found: ${templatePath}</h2></body></html>`;
  }

  html = html.replace(/\{\{FUNC_NAME\}\}/g, action);
  html = html.replace(/\{\{PAYLOAD_JSON\}\}/g, payloadDisplay);
  html = html.replace(/\{\{REQUEST_ID\}\}/g, requestId);
  html = html.replace(/\{\{REFERENCED_MSG\}\}/g, refMsgDisplay);
  html = html.replace(/\{\{RESOLVED_NAMES\}\}/g, JSON.stringify(resolvedNames || {}));
  return html;
}

// ── Request tracking ────────────────────────────────────────────────────────

interface InFlightRequest {
  action: string;
  payload: Record<string, unknown>;
  resolve: (response: HITLResponse) => void;
  store?: any;
}

const activeRequests = new Map<string, InFlightRequest>();

// ── HTTP server ─────────────────────────────────────────────────────────────

/**
 * Parse query string parameters from a URL.
 */
function parseQuery(url: string): Map<string, string> {
  const params = new Map<string, string>();
  const idx = url.indexOf("?");
  if (idx === -1) return params;
  const qs = url.slice(idx + 1);
  for (const pair of qs.split("&")) {
    const [key, ...rest] = pair.split("=");
    if (key) params.set(decodeURIComponent(key), decodeURIComponent(rest.join("=")));
  }
  return params;
}

/**
 * Read the full request body as a string.
 */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

/**
 * Handle GET /review?id=<uuid> — serve the review page.
 * Handle GET /assets/hitl.css — serve the stylesheet.
 */
function handleGet(request: IncomingMessage, response: ServerResponse): void {
  const url = request.url || "/";

  // CSS route
  if (url === "/assets/hitl.css") {
    try {
      const css = readFileSync(STYLESHEET_PATH);
      response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
      response.end(css);
    } catch {
      response.writeHead(404).end("CSS not found");
    }
    return;
  }

  // Review page route
  if (url.startsWith("/review")) {
    const params = parseQuery(url);
    const requestId = params.get("id") || "";
    const req = activeRequests.get(requestId);
    if (!req) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Review request not found.");
      return;
    }

    // Select template based on review mode (message actions get the message template)
    const isMessage = ["send-text", "send-image", "send-video", "send-audio",
      "send-document", "send-sticker", "send-location", "send-contact",
      "send-poll", "edit-message", "forward-message",
      "send-batch", "send-reaction", "delete-message"].includes(req.action);
    const templatePath = isMessage ? MESSAGE_TEMPLATE_PATH : TEMPLATE_PATH;

    // Resolve JIDs to names for all actions that reference contacts/groups
    const resolvedNames: Record<string, string> = {};
    if (req.store) {
      const jidsToResolve = new Set<string>();
      const payload = req.payload;
      if (payload.jid) jidsToResolve.add(String(payload.jid));
      if (payload.to) jidsToResolve.add(String(payload.to));
      if (payload.to_jid) jidsToResolve.add(String(payload.to_jid));
      if (payload.from_chat) jidsToResolve.add(String(payload.from_chat));
      if (Array.isArray(payload.jids)) for (const j of payload.jids) jidsToResolve.add(String(j));
      if (Array.isArray(payload.to)) for (const j of payload.to) jidsToResolve.add(String(j));
      if (Array.isArray(payload.contacts)) {
        for (const c of payload.contacts) if (c.phone) jidsToResolve.add(String(c.phone));
      }
      for (const jid of jidsToResolve) {
        try {
          const name = req.store.resolveContactName(jid);
          if (name) resolvedNames[jid] = name;
        } catch { /* non-fatal */ }
      }
    }

    // Fetch referenced message for actions that reference existing messages
    let referencedMsg: Record<string, unknown> | null = null;
    const refActions = ["delete-message", "edit-message", "send-reaction", "forward-message"];
    if (refActions.includes(req.action) && req.store) {
      const messageId = String(req.payload.message_id || req.payload.from_message_id || "");
      const jid = String(req.payload.jid || "");
      if (messageId) {
        try {
          const msg = req.store.getMessage(messageId);
          if (msg) {
            referencedMsg = msg as unknown as Record<string, unknown>;
            // Also resolve JIDs in the referenced message
            const msgJid = (msg as any)?.key?.remoteJid;
            if (msgJid && !resolvedNames[msgJid]) {
              try {
                const name = req.store.resolveContactName(msgJid);
                if (name) resolvedNames[msgJid] = name;
              } catch { /* non-fatal */ }
            }
          }
        } catch { /* message not in store — non-fatal */ }
        if (!referencedMsg && jid) {
          // Fallback: try to get chat info for the JID
          try {
            const chat = req.store.getChat(jid);
            if (chat) referencedMsg = { info: { name: (chat as any)?.name || (chat as any)?.pushName || jid, jid } } as Record<string, unknown>;
          } catch { /* non-fatal */ }
        }
      }
    }

    const html = renderTemplate(templatePath, requestId, req.action, req.payload, referencedMsg, resolvedNames);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }

  response.writeHead(404).end("Not found");
}

/**
 * Handle POST /submit — collect the reviewer's decision and unblock the caller.
 */
async function handlePost(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.url !== "/submit") {
    response.writeHead(404).end("Not found");
    return;
  }

  let body: string;
  try {
    body = await readBody(request);
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain" });
    response.end("Failed to read request body.");
    return;
  }

  let submitted: Record<string, unknown>;
  try {
    submitted = JSON.parse(body);
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain" });
    response.end("Invalid JSON.");
    return;
  }

  const requestId = String(submitted.id || "");
  const req = activeRequests.get(requestId);
  if (!req) {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Review request not found.");
    return;
  }

  const status = String(submitted.status || "rejected");
  if (!["approved", "rejected"].includes(status)) {
    response.writeHead(400, { "Content-Type": "text/plain" });
    response.end("Invalid status.");
    return;
  }

  // Parse submitted payload
  let payload: Record<string, unknown> | null = null;
  const rawPayload = submitted.payload;
  if (rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)) {
    payload = rawPayload as Record<string, unknown>;
  } else if (typeof rawPayload === "string") {
    try {
      const parsed = JSON.parse(rawPayload);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed;
      }
    } catch {
      // Not valid JSON — use as-is if it's an object
    }
  }

  // Fall back to original payload if none submitted
  if (!payload) payload = req.payload;

  // Compare only fields that existed in the original — the template's sync()
  // adds helper fields like `to`, which must NOT count as a reviewer edit.
  const edited = Object.keys(req.payload).some(
    (k) => JSON.stringify(payload[k]) !== JSON.stringify(req.payload[k]),
  );
  const comment = String(submitted.comment || "");

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end('{"ok":true}');

  // Unblock the caller
  activeRequests.delete(requestId);
  req.resolve({
    status: status as "approved" | "rejected",
    payload: status === "approved" ? payload : null,
    edited,
    comment,
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Open a local editable review page and await a human decision.
 *
 * Args:
 *   action: Kebab-case action being reviewed.
 *   payload: Validated action payload proposed by the caller.
 *   opts: Optional review mode override.
 *
 * Returns:
 *   The approval decision, submitted payload, edit flag, and reviewer comment.
 *   A timeout produces `status="rejected"`.
 *
 * Examples:
 *   await requestApproval("send-text", { jid: "33600000000", text: "Hello" })
 *   // => { status: "approved", payload: { jid: "33600000000", text: "Hello" }, edited: false, comment: "" }
 *
 *   await requestApproval("delete-message", { jid: "120363@g.us", message_id: "ABC" })
 *   // => { status: "rejected", payload: null, edited: false, comment: "Too destructive" }
 */
export function requestApproval(
  action: string,
  payload: Record<string, unknown>,
  opts?: { reviewMode?: string; store?: any },
): Promise<HITLResponse> {
  const requestId = randomUUID();

  return new Promise<HITLResponse>((resolve) => {
    const server = createServer(async (request, response) => {
      try {
        if (request.method === "GET") {
          handleGet(request, response);
        } else if (request.method === "POST") {
          await handlePost(request, response);
        } else {
          response.writeHead(405).end("Method not allowed");
        }
      } catch (error) {
        response.writeHead(500, { "Content-Type": "text/plain" });
        response.end(`Internal error: ${(error as Error).message}`);
      }
    });

    // Track this request
    activeRequests.set(requestId, { action, payload, resolve, store: opts?.store });

    // Timeout → fail-closed
    const timeout = setTimeout(() => {
      activeRequests.delete(requestId);
      server.close();
      resolve({
        status: "rejected",
        payload: null,
        edited: false,
        comment: "HITL timeout expired (no response received)",
      });
    }, TIMEOUT_MS);

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const url = `http://127.0.0.1:${port}/review?id=${requestId}`;

      process.stderr.write(
        `\n🚀 [HITL] ACTION REVIEW REQUIRED\n` +
        `🔗 ${url}\n` +
        `📝 Action: ${action}\n` +
        `If the browser doesn't open, connect from a machine with a GUI:\n` +
        `   ssh -L ${port}:localhost:${port} your-host\n`,
      );

      // Suppress auto-open in tests, CI, or headless environments
      if (!process.env.WHATS_PROXY_NO_BROWSER) {
        // Small delay to ensure the server is fully accepting connections
        setTimeout(() => {
          try {
            execCb(`xdg-open '${url}'`, () => {});
          } catch {
            /* URL remains available on stderr */
          }
        }, 200);
      }
    });
  });
}
