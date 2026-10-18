#!/bin/zsh
# Builds the native helpers (bin/portal-helper, bin/portal-mac) for Apple Silicon and Intel Macs.
set -e
cd "$(dirname "$0")/.."
mkdir -p bin
tmp=$(mktemp -d)
# portal-helper: screen capture and remote input. portal-mac: apps, windows, accessibility for the Mac agent.
for name in portal-helper portal-mac; do
  src=native/$name.swift; [ $name = portal-mac ] && src=native/mac-helper.swift
  for arch in arm64 x86_64; do
    xcrun swiftc -O -swift-version 5 -target $arch-apple-macos12.3 $src -o "$tmp/$name-$arch"
  done
  lipo -create "$tmp/$name-arm64" "$tmp/$name-x86_64" -output bin/$name
  codesign --force --sign - bin/$name
done
rm -rf "$tmp"
echo "Built bin/portal-helper and bin/portal-mac"
