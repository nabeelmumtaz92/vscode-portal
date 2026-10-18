#!/bin/bash
# Builds VSCode Portal on this Mac and uploads it to TestFlight. 
# Usage: scripts/testflight.sh            (bumps build number, archives, uploads)
#        scripts/testflight.sh --no-upload (archive + export only)
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IOS="$APP_DIR/ios"
OUT="$HOME/Library/Caches/vscodeportal-build"
KEY_ID="394JQ5DSAW"
ISSUER="d19a8b03-b4a6-4c45-9474-9d1fe26165a6"
KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8"
export DEVELOPER_DIR="/Applications/Xcode_26.6.app/Contents/Developer"
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
UPLOAD=1; [ "${1:-}" = "--no-upload" ] && UPLOAD=0

[ -f "$KEY_PATH" ] || { echo "Missing API key at $KEY_PATH"; exit 1; }
mkdir -p "$OUT"; rm -rf "$OUT/archive.xcarchive" "$OUT/export"

# Next build number = last uploaded + 1, kept in a local file.
BUILD_FILE="$OUT/build-number"
BUILD=$(( $(cat "$BUILD_FILE" 2>/dev/null || echo 0) + 1 ))
echo "== Build $BUILD =="

cd "$APP_DIR"
if [ ! -d node_modules ]; then npm install --legacy-peer-deps; fi
(cd ios && pod install --silent)

xcodebuild archive \
  -workspace "$IOS/CodePortal.xcworkspace" -scheme CodePortal \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$OUT/archive.xcarchive" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$KEY_PATH" -authenticationKeyID "$KEY_ID" -authenticationKeyIssuerID "$ISSUER" \
  CURRENT_PROJECT_VERSION="$BUILD" DEVELOPMENT_TEAM=5Z5CXL8GJR \
  | tail -n 25

cat > "$OUT/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>5Z5CXL8GJR</string>
  <key>signingStyle</key><string>automatic</string>
  <key>destination</key><string>$([ $UPLOAD = 1 ] && echo upload || echo export)</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PLIST

xcodebuild -exportArchive -archivePath "$OUT/archive.xcarchive" -exportPath "$OUT/export" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" -allowProvisioningUpdates \
  -authenticationKeyPath "$KEY_PATH" -authenticationKeyID "$KEY_ID" -authenticationKeyIssuerID "$ISSUER" \
  | tail -n 15

echo "$BUILD" > "$BUILD_FILE"
[ $UPLOAD = 1 ] && echo "Uploaded build $BUILD to TestFlight. It shows in App Store Connect after processing (~10 min)." || echo "Exported to $OUT/export"
