#!/usr/bin/env node
/**
 * Start the WhatsApp proxy with Node.js and the bundled TypeScript loader.
 *
 * Baileys requires Node-compatible `ws` client upgrade events, while the
 * application source deliberately remains TypeScript. Registering `tsx` here
 * keeps the published CLI executable without a generated JavaScript tree.
 *
 * Examples:
 *   node bin/whats-proxy.mjs --version
 *   // => {"meta":{"status":"ok",...},"data":{"version":"0.3.0"}}
 *   node bin/whats-proxy.mjs do --help
 *   // => "messaging:\n  send-text\n..."
 */

import { register } from "tsx/esm/api";

register();
await import("../src/whats_proxy/index.ts");
