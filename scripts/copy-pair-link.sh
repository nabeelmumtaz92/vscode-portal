#!/bin/bash
# Copies the "From anywhere" pairing link to the Mac clipboard without printing it.
# Paste it into another app's web view, or open it in a browser on another device.
# The link contains the pairing key. Treat it like a password.
set -euo pipefail
RELAY="${VSCODE_PORTAL_RELAY_URL:-https://vscode-portal-relay-production.up.railway.app}"
PAIR="$HOME/.vscode-portal/pairing.json"
[ -f "$PAIR" ] || { echo "No pairing yet. Run 'VSCode Portal: Connect Phone (QR Code)' in VS Code first."; exit 1; }
LINK="$(python3 -c "import json,sys;d=json.load(open('$PAIR'));print('$RELAY/#pair=%s.%s'%(d['key'],d['room']))")"
printf '%s' "$LINK" | pbcopy
echo "Pairing link copied to the clipboard (${#LINK} characters). Paste it in R.I.T.A. on the phone."
