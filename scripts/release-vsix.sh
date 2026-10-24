#!/bin/zsh
# Build vscode-portal.vsix on the Mac and attach it to the GitHub release for the current version,
# so other computers (e.g. the Windows laptop via scripts/install-windows.ps1) can download it.
set -e
cd "$(dirname "$0")/../extension"
npm install --no-audit --no-fund
npm run build
npx --yes @vscode/vsce package -o vscode-portal.vsix
TAG="v$(node -p 'require("./package.json").version')"
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release upload "$TAG" vscode-portal.vsix --clobber
else
  gh release create "$TAG" vscode-portal.vsix --title "VSCode Portal $TAG" --notes "Extension package for install-windows.ps1 / manual install."
fi
echo "Published vscode-portal.vsix to release $TAG."
