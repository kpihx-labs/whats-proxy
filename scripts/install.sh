#!/usr/bin/env bash
set -euo pipefail

echo "🚀 Installing whats-proxy..."
bun install
bun link
echo "✅ whats-proxy installed. Run 'whats-proxy --help' to start."
echo "   First use: whats-proxy admin setup   (pair your WhatsApp account)"
