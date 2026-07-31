#!/usr/bin/env bun
/**
 * whats-proxy — entry point.
 *
 * Single binary, namespaced CLI (mirrors tg-proxy):
 *   whats-proxy do <action> [payload|file] [-o file] [-f json|table]
 *   whats-proxy admin setup [--code] [--phone N]
 *   whats-proxy admin status
 *   whats-proxy daemon            (internal — auto-spawned by `do`)
 */

import { main } from "./cli.ts";

process.exitCode = await main(process.argv.slice(2));
