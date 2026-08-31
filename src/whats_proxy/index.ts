#!/usr/bin/env node
/**
 * whats-proxy — entry point.
 *
 * Single binary, namespaced CLI (follows tick-proxy). Bun owns installation
 * and testing; Node.js runs the production binary because Baileys requires
 * `ws` upgrade events Bun 1.3.11 does not implement.
 *   whats-proxy do <action> [payload|file] [-o file] [-f json|table]
 *   whats-proxy admin auth login [--code] [--phone N]
 *   whats-proxy admin auth status|logout|use
 *   whats-proxy admin service start|stop|restart|logs|status|refresh <phone>
 *   whats-proxy daemon            (internal — auto-spawned by `do`)
 */

import { main } from "./cli.ts";

process.exitCode = await main(process.argv.slice(2));
