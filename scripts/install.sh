#!/usr/bin/env bash
set -euo pipefail

echo "🚀 Installing whats-proxy..."
bun install
bun link

# Shell completions (best-effort; user shell detection, no hard failures).
COMPLETIONS_DIR="$(cd "$(dirname "$0")/../completions" && pwd)"
if [ -n "${ZSH_VERSION:-}" ] || [ -n "${ZSH:-}" ]; then
  ZSH_COMPLETIONS="${ZSH_COMPLETIONS:-${ZDOTDIR:-$HOME}/.zsh/completions}"
  mkdir -p "$ZSH_COMPLETIONS"
  ln -sf "$COMPLETIONS_DIR/_whats-proxy" "$ZSH_COMPLETIONS/_whats-proxy"
  echo "   zsh completion → $ZSH_COMPLETIONS/_whats-proxy (ensure it is in fpath)"
elif [ -n "${BASH_VERSION:-}" ] || [ -n "${BASH:-}" ]; then
  BASH_COMPLETIONS="${BASH_COMPLETIONS:-$HOME/.local/share/bash-completion/completions}"
  mkdir -p "$BASH_COMPLETIONS"
  ln -sf "$COMPLETIONS_DIR/whats-proxy.bash" "$BASH_COMPLETIONS/whats-proxy"
  echo "   bash completion → $BASH_COMPLETIONS/whats-proxy"
else
  echo "   (shell not detected — completions in $COMPLETIONS_DIR)"
fi

echo "✅ whats-proxy installed. Run 'whats-proxy --help' to start."
echo "   First use: whats-proxy admin setup   (pair your WhatsApp account)"
