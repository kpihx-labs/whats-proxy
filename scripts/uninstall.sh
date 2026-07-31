#!/usr/bin/env bash
set -euo pipefail

echo "🗑️  Uninstalling whats-proxy..."
bun unlink 2>/dev/null || true

# Session credentials live in ~/.config/whats-proxy/state/ (Baileys auth).
# Destroying them forces a full re-pairing — make that explicit.
if [ -d "${WHATS_PROXY_STATE_DIR:-$HOME/.config/whats-proxy}/state" ]; then
  echo "⚠️  Found WhatsApp session credentials in state/."
  read -r -p "Delete them too? (y/N — deleting forces re-pairing): " confirm
  if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "✅ whats-proxy unlinked. Session credentials KEPT (state/ preserved)."
    echo "   To remove them later: rm -rf ${WHATS_PROXY_STATE_DIR:-$HOME/.config/whats-proxy}/state"
    exit 0
  fi
fi

rm -rf "${WHATS_PROXY_STATE_DIR:-$HOME/.config/whats-proxy}"
rm -rf /tmp/whats-proxy-autosave
echo "✅ whats-proxy fully removed."
