#!/bin/zsh
# Build VSCode Portal, package it and install it into VS Code. Then reload VS Code windows.
set -e
cd "$(dirname "$0")/../extension"
npm install --no-audit --no-fund
npm run build
npx --yes @vscode/vsce package -o vscode-portal.vsix
CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
"$CODE" --install-extension vscode-portal.vsix --force
echo "Installed. In VS Code run 'Developer: Reload Window', then click 'Portal' in the status bar."
