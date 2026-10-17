#!/bin/zsh
# Builds bin/portal-helper, the screen helper, for Apple Silicon and Intel Macs.
set -e
cd "$(dirname "$0")/.."
mkdir -p bin
tmp=$(mktemp -d)
for arch in arm64 x86_64; do
  xcrun swiftc -O -swift-version 5 -target $arch-apple-macos12.3 native/portal-helper.swift -o "$tmp/portal-helper-$arch"
done
lipo -create "$tmp/portal-helper-arm64" "$tmp/portal-helper-x86_64" -output bin/portal-helper
codesign --force --sign - bin/portal-helper
rm -rf "$tmp"
echo "Built bin/portal-helper"
