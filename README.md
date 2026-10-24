# VSCode Portal

VS Code + Portal in one phone app. From your iPhone (or any browser) you can code in a real VS Code window on your Mac, see and control the whole Mac, and ask Claude to do things on it. It replaces the old Portal.

Instead of streaming everything as video, the coding parts send structured data, so they are fast and crisp on cellular. The Screen tab streams real H.264 video when you need to see the Mac.

## What it does

**Prompt: Claude Code on your Mac.** Every chat is a saved Claude Code session (your existing Claude login, no API key). Each message picks a mode:
- **🖥 Mac:** Claude controls the whole Mac with Portal's tools: screenshots and zoom, clicks, drag, scroll, typing, keys, opening and quitting apps, files and links, windows, accessibility (find/press/fill UI elements by name), clipboard, volume, brightness, media, and any monitor.
- **Auto-edit:** edits files and runs safe commands (git status/diff/add/commit/push, npm test/build/lint, tsc).
- **Full access:** anything (bypass permissions).
- **Plan only:** read and plan, no changes.

Chats are searchable and keep running in the background (several at once; they take turns with the mouse and keyboard). Add to a running task, get an "End of task" marker, tap to resend an undelivered message, and keep memory notes. Risky terminal commands show an Allow/Deny card. Attach photos, videos (they become frames Claude can view) and documents; uploads resume across dropped connections.

**Screen.** Live hardware H.264 (ScreenCaptureKit + VideoToolbox) up to 60 fps, one monitor or all screens side by side, pinch zoom, quality and frame-rate sliders, a latency chip, and flow control that adapts to weak connections. Touch and Trackpad modes, tap, double-tap, right-click, drag, scroll with momentum, a key bar with sticky ⌘⌥⌃⇧, clipboard both ways, haptics in the app.

**Files / Editor.** Browse and search the workspace and edit in CodeMirror. Edits go live into the VS Code window on the Mac, and Mac edits show on the phone.

**Changes.** Git branch and changed files with diffs, Commit / Push, "✨ Commit & push" via Claude, and VS Code's Problems with "Ask Claude to fix".

**Terminal.** Run commands with output on the phone, or send them to the VS Code terminal on the Mac.

**Siri and Shortcuts.** "Hey Siri, ask Portal" asks what your Mac should do, runs it as a Mac-mode chat and reads the reply back with a picture. "Show my Mac's screen in Portal" returns a current screenshot. Both work as Shortcuts actions.

**Always on.** "VSCode Portal: Keep Running When VS Code Is Closed" installs a background host (`com.vscodeportal.host`) so the Mac stays reachable when VS Code is closed. It shows on the phone as "<Mac> (always on)" with Files, Terminal, Screen and Mac-mode Claude.

**Embed it in another app.** The phone web app can run inside another app's web view through the relay; `scripts/copy-pair-link.sh` copies the pairing link to the clipboard without printing it.

## Connecting

| Way | Needs | Notes |
|---|---|---|
| **From anywhere (relay)** | nothing installed on the phone | End-to-end encrypted through a relay on Railway. Scan a QR code once; the phone stays paired. The pairing key lives in the phone's Keychain/Keystore. |
| **Same Wi-Fi** | nothing | Direct to the Mac. |
| **Tailscale** | Tailscale on both devices | Private tailnet link, see below. |

To pair, run **VSCode Portal: Connect Phone (QR Code)** in VS Code. To use the same pairing somewhere you can't scan, such as another app's web view or another computer's browser, run `scripts/copy-pair-link.sh` to copy the link, then paste it there. The link contains the pairing key, so treat it like a password. Use **VSCode Portal: Unpair All Phones** to revoke every pairing.

## How it fits together

```
phone / browser / another app's web view ── WebSocket (JSON, E2E encrypted via relay) ──▶  VS Code extension (server.js in the extension host)
                                                                  ├─ VS Code API: documents, tabs, diagnostics, terminal
                                                                  ├─ git / zsh for Changes and Terminal
                                                                  ├─ claude -p --output-format stream-json  (Prompt, Mac mode over MCP)
                                                                  └─ native helpers: portal-helper (screen + input), portal-mac (accessibility)
```

| Path | What it is |
|---|---|
| `extension/extension.js` | VS Code side: live document sync, tabs, problems, terminal, status bar, commands |
| `extension/server.js` | HTTP + WebSocket API, auth, git, commands, Claude Code runner (testable without VS Code) |
| `extension/screen.js` | Screen streaming and input, flow control |
| `extension/chats.js`, `extension/agent/` | Saved chats, memory, and the Mac-control agent (tools over MCP) |
| `extension/native/` | Swift helpers: `portal-helper` (ScreenCaptureKit + VideoToolbox), `mac-helper` (accessibility) |
| `extension/standalone.js`, `extension/always-on.js` | The always-on host that runs without VS Code |
| `extension/web/` | The phone web app (installable to the Home Screen) |
| `mobile/` | iPhone and Android app (React Native, no Expo) with Siri/Shortcuts intents (`mobile/ios/CodePortal/PortalIntents.swift`) |
| `relay/` | The relay server (deployed on Railway) |
| `scripts/` | `install.sh`, `deploy-relay.sh`, `copy-pair-link.sh` |
| `HANDOFF.md` | Current status, what is done, what is left |

## Setup

```bash
scripts/install.sh            # build, package, install into VS Code; then reload VS Code windows
```

Each VS Code window serves on port 7788, the next window on 7789, and so on (see the **Portal :port** status bar item). The access code lives in `~/.vscode-portal/token`.

Screen sharing and Mac control: run **VSCode Portal: Turn On Screen Sharing**. macOS asks once for Screen Recording and Accessibility.

Relay: `scripts/deploy-relay.sh` redeploys the relay and the phone web app to Railway (https://vscode-portal-relay-production.up.railway.app).

Tailscale (optional): publish a window on your tailnet, private and not public:

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=8443 http://127.0.0.1:7788
```

Then set `vscodePortal.publicUrl` to `https://<your-mac>.<tailnet>.ts.net:8443`.

The iPhone app goes to TestFlight with the script in `mobile/` (see `mobile/scripts`).

### Windows PC

On the Mac, publish the built extension once per version: `scripts/release-vsix.sh` (attaches `vscode-portal.vsix` to the GitHub release).
On the PC, in PowerShell: `irm https://raw.githubusercontent.com/nabeelmumtaz92/vscode-portal/main/scripts/install-windows.ps1 | iex` (installs VS Code and Claude Code if missing; re-run to update).
Prompt, Files/Editor, Changes and Terminal (PowerShell) work on Windows; Screen, Mac mode and Always on need a Mac.

## Tests

```bash
cd extension && npm test
```
