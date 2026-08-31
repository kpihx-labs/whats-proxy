#!/bin/bash
# Patch Baileys to handle companion_reg_refresh notifications.
# WhatsApp QR pairing fix — upstream PR #2765 (issue #2737).
# Since ~2026-07-28 WhatsApp sends <notification type='companion_reg_refresh'>
# after QR scan. Without this handler, the adv secret gets retired but the QR
# keeps showing the old one, so the phone rejects the link.
# Remove this when PR #2765 is merged into a Baileys release.
set -euo pipefail

SOCKET_JS="node_modules/@whiskeysockets/baileys/lib/Socket/socket.js"
if [ ! -f "$SOCKET_JS" ]; then
  echo "patch-baileys: $SOCKET_JS not found, skipping"
  exit 0
fi

# Skip if already patched
if grep -q "PATCHED.*companion_reg_refresh" "$SOCKET_JS" 2>/dev/null; then
  exit 0
fi

echo "patch-baileys: applying companion_reg_refresh fix (PR #2765)"

# We use a Python one-liner for reliability — sed can't handle multiline insertions cleanly.
python3 - "$SOCKET_JS" <<'PYEOF'
import sys, re

path = sys.argv[1]
with open(path, 'r') as f:
    src = f.read()

# --- Patch 1: advSecretKey read at render time ---
# Original: const advB64 = creds.advSecretKey;
# We remove it and read creds.advSecretKey directly in the QR builder.
src = src.replace(
    '        const advB64 = creds.advSecretKey;\n        let qrMs',
    '        let qrMs'
)
# The QR builder already references advB64 — replace it with creds.advSecretKey
# (may already be patched if postinstall runs twice)
src = src.replace('advB64, browser)', 'creds.advSecretKey, browser)')

# --- Patch 2: Insert refreshQR + currentRef tracking before genPairQR ---
if 'PATCHED: refreshQR' not in src:
    # Find the genPairQR definition and insert before it
    marker = '        const genPairQR = () => {'
    refresh_code = """        /* PATCHED: refreshQR for companion_reg_refresh (PR #2765) */
        let currentRef = undefined;
        const refreshQR = () => {
            if (!ws.isOpen || !currentRef) return;
            const qr = buildPairingQRData(currentRef, noiseKeyB64, identityKeyB64, creds.advSecretKey, browser);
            ev.emit('connection.update', { qr });
        };
"""
    src = src.replace(marker, refresh_code + marker)

# --- Patch 3: Track currentRef in genPairQR ---
src = src.replace(
    "            const ref = refNode.content.toString('utf-8');\n            const qr = buildPairingQRData(ref,",
    "            currentRef = refNode.content.toString('utf-8');\n            const qr = buildPairingQRData(currentRef,"
)

# --- Patch 4: Insert companion_reg_refresh handler after pair-device ---
handler = """    /* PATCHED: handle companion_reg_refresh — rotate adv secret (PR #2765) */
    ws.on('CB:notification,type:companion_reg_refresh', (node) => {
        const expected = ['companion_reg_refresh', 'pair-device-rotate-qr'];
        const child = node.content && Array.isArray(node.content)
            ? node.content.find(c => expected.includes(c.tag))
            : null;
        if (!child) { logger.warn('companion_reg_refresh: no expected child; ignoring'); return; }
        if (creds.me) { logger.debug('companion_reg_refresh on registered session; skipping'); return; }
        creds.advSecretKey = randomBytes(32).toString('base64');
        ev.emit('creds.update', { advSecretKey: creds.advSecretKey });
        logger.info('Rotated adv secret per server request; re-rendering QR');
        refreshQR();
    });
"""
if 'CB:notification,type:companion_reg_refresh' not in src:
    insert_after = "        genPairQR();\n    });\n    // device paired for the first time"
    src = src.replace(insert_after, "        genPairQR();\n    });\n" + handler + "    // device paired for the first time")

with open(path, 'w') as f:
    f.write(src)

print("patch-baileys: applied successfully")
PYEOF
