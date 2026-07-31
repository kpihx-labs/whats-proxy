#!/usr/bin/env bash
set -euo pipefail

echo "🗑️  Uninstalling whats-proxy..."
bun unlink 2>/dev/null || true
rm -rf ~/.config/whats-proxy
rm -rf /tmp/whats-proxy-autosave
echo "✅ whats-proxy fully removed."
