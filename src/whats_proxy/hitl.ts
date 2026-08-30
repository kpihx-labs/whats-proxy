/**
 * Human-in-the-loop review for potentially consequential WhatsApp actions.
 *
 * The review server is deliberately local-only and binds directly to port zero,
 * so concurrent requests cannot race over a reserved port. It exposes the full
 * JSON payload for deliberate human correction, then returns an approved or
 * rejected outcome to the daemon without ever writing review data to disk.
 *
 * Examples:
 *   await requestApproval("send-text", { jid: "33600000000", text: "Hello" })
 *   // => { status: "approved", payload: { jid: "33600000000", text: "Hello" }, edited: false, comment: "" }
 *
 *   await requestApproval("delete-message", { jid: "120363@g.us", message_id: "ABC" })
 *   // => { status: "rejected", payload: null, edited: false, comment: "Too destructive" }
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

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

/**
 * Render the self-contained review page for exactly one approval request.
 *
 * Args:
 *   action: Human-readable action name displayed in the page heading.
 *   payload: Original validated JSON object placed in the editable editor.
 *   requestId: Cryptographically random token required by the review POST.
 *
 * Returns:
 *   Complete HTML markup for the local-only review page.
 *
 * Examples:
 *   html("send-text", { jid: "33600000000", text: "Hello" }, "request-1").includes("send-text")
 *   // => true
 *   html("delete-message", { message_id: "ABC" }, "request-2").includes("request-2")
 *   // => true
 */
function html(action: string, payload: Record<string, unknown>, requestId: string): string {
  const escapedPayload = JSON.stringify(payload, null, 2).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const escapedAction = action.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Whats-Proxy review · ${escapedAction}</title>
<style>
body{margin:0;background:#101416;color:#e8f0eb;font:15px system-ui,sans-serif}.wrap{max-width:960px;margin:40px auto;padding:0 20px}.card{background:#18201c;border:1px solid #314638;border-radius:12px;padding:22px;margin:16px 0}h1{font-size:22px;margin:0 0 8px}p{color:#aab9ad}textarea{box-sizing:border-box;width:100%;min-height:360px;background:#0c100e;color:#e8f0eb;border:1px solid #526a59;border-radius:8px;padding:14px;font:13px ui-monospace,monospace}input{box-sizing:border-box;width:100%;background:#0c100e;color:#e8f0eb;border:1px solid #526a59;border-radius:8px;padding:10px}button{border:0;border-radius:8px;padding:12px 16px;font-weight:700;cursor:pointer}.approve{background:#43d17c;color:#082012}.reject{background:#d95a68;color:#fff;margin-left:8px}.error{color:#ff9da7;min-height:20px}.note{font-size:13px;color:#aab9ad}</style></head>
<body><main class="wrap"><section class="card"><h1>Human review required</h1><p><strong>${escapedAction}</strong> can change WhatsApp or local proxy state. Review the complete payload before approving.</p></section>
<section class="card"><label for="payload"><strong>Reviewed JSON payload</strong></label><textarea id="payload" spellcheck="false">${escapedPayload}</textarea><p class="note">You may edit valid JSON. Target identifiers preflighted by the daemon remain locked for destructive actions.</p><label for="comment"><strong>Comment (optional)</strong></label><input id="comment" maxlength="2000" placeholder="Why approve or reject?"><p class="error" id="error"></p><button class="approve" onclick="submitReview('approved')">Approve</button><button class="reject" onclick="submitReview('rejected')">Reject</button></section></main>
<script>const original=document.querySelector('#payload').value;async function submitReview(status){const error=document.querySelector('#error');let payload=null;try{payload=JSON.parse(document.querySelector('#payload').value)}catch(e){error.textContent='Payload must be valid JSON: '+e.message;return}if(!payload||Array.isArray(payload)||typeof payload!=='object'){error.textContent='Payload must be a JSON object.';return}const response=await fetch('/review',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'${requestId}',status,payload,comment:document.querySelector('#comment').value})});if(!response.ok){error.textContent=await response.text();return}document.body.innerHTML='<main class="wrap"><section class="card"><h1>Review recorded</h1><p>You can close this tab.</p></section></main>'}</script></body></html>`;
}

/**
 * Open a local editable review page and await a human decision.
 *
 * Args:
 *   action: Kebab-case action being reviewed.
 *   payload: Validated action payload proposed by the caller.
 *
 * Returns:
 *   The approval decision, submitted payload, edit flag, and reviewer comment.
 *
 * Examples:
 *   await requestApproval("group-leave", { jid: "120363@g.us" })
 *   // => { status: "approved", payload: { jid: "120363@g.us" }, edited: false, comment: "" }
 *   await requestApproval("channel-delete", { jid: "120363@newsletter" })
 *   // => { status: "rejected", payload: null, edited: false, comment: "Not now" }
 */
export async function requestApproval(action: string, payload: Record<string, unknown>): Promise<HITLResponse> {
  const requestId = randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (response: HITLResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close();
      resolve(response);
    };
    const server = createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html(action, payload, requestId));
        return;
      }
      if (request.method !== "POST" || request.url !== "/review") {
        response.writeHead(404).end("Not found");
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      try {
        const submitted = JSON.parse(body) as { id?: string; status?: string; payload?: unknown; comment?: unknown };
        if (submitted.id !== requestId || !["approved", "rejected"].includes(String(submitted.status))) throw new Error("Invalid review request.");
        if (!submitted.payload || Array.isArray(submitted.payload) || typeof submitted.payload !== "object") throw new Error("Payload must be a JSON object.");
        response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
        const reviewed = submitted.payload as Record<string, unknown>;
        finish({ status: submitted.status as "approved" | "rejected", payload: submitted.status === "approved" ? reviewed : null, edited: JSON.stringify(reviewed) !== JSON.stringify(payload), comment: String(submitted.comment || "") });
      } catch (error) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end((error as Error).message);
      }
    });
    const timeout = setTimeout(() => finish({ status: "rejected", payload: null, edited: false, comment: "HITL timeout expired (no response received)" }), TIMEOUT_MS);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const url = `http://127.0.0.1:${port}/`;
      process.stderr.write(`\n🚀 [HITL] ACTION REVIEW REQUIRED\n   Action: ${action}\n   Review: ${url}\n   Timeout: ${TIMEOUT_MS / 1000}s\n`);
      // Suppress auto-open in tests, CI, or headless environments.
      if (!process.env.WHATS_PROXY_NO_BROWSER) {
        try { Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" }); } catch { /* URL remains available on stderr. */ }
      }
    });
  });
}
