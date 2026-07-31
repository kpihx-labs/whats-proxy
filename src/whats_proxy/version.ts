/**
 * whats-proxy — single source of truth for the CLI version.
 * Reads from package.json (the canonical version location for a Bun package).
 */

import pkg from "../../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
