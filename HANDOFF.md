# Handoff: make VSCode Portal replace Portal entirely (Oct 17 2026)

Read this first in a fresh Claude Code session. Goal from the owner: **retire the old Portal (`~/Desktop/Portal`) and use
VSCode Portal for everything**, so VSCode Portal must have every feature Portal has. Work on branch `screen`
(already pushed; `main` is behind).

## What VSCode Portal has now
Claude Code prompts (stream-json, modes), Files/Editor with live sync, Changes (git), Terminal, Screen tab (see and control
the Mac), photo/video attach (videos become frames Claude can view), switching between VS Code windows, relay for use without
Tailscale (QR pairing, Railway: https://vscode-portal-relay-production.up.railway.app, redeploy `scripts/deploy-relay.sh`),
and an iPhone/Android React Native app in `mobile/`. Install with `scripts/install.sh`, then Reload Window. Ports 7788+ per window,
token in `~/.vscode-portal/token`.

## What the old Portal does (check each against VSCode Portal; build what's missing)
Old repo `~/Desktop/Portal` (private; `portal-server.js`, `agent/`, `web/index.html`, `ios/`):
- Live Mac screen streaming (H.264 via ffmpeg, WebCodecs on web, native decoder in the iOS app), multi-monitor selection,
  touch/trackpad control, keyboard, scroll, pinch zoom, clipboard.
- "Ask" agent that controls the Mac with tools (`agent/agent.py`, `bridge.py`, `claude_cli.py`, `mac.py`, `quick_actions.py`):
  accessibility-based clicking, shell, open apps, screenshots, run on the owner's Claude plan through Claude Code.
- Chat history with search, memory facts, several tasks in parallel, add-while-working, approval only for dangerous commands,
  "End of task" marker, resend for unconfirmed messages.
- Attachments: photos, documents, and videos sent in 1 MB pieces with retry across connection drops (see `sendWithVideos` in
  `web/index.html` and `receive_chunk` in `agent/bridge.py`).
- Push notifications ("done", "needs your OK"), installable web app/PWA, native iOS app with over-the-air updates
  (`tools/publish-ios-app.sh`, `/install`), Tailscale Funnel at https://nabeels-mac-mini.tail74c059.ts.net, launch agent
  that keeps the server running.
- Fixes learned the hard way: iOS Safari zooms the page when a text box has font under 16px and pushes the send button off-screen
  (fixed with 16px input and max-scale); a dropped websocket silently loses queued messages; a 15 s heartbeat can kill the socket during
  large uploads.

## Open work on this branch
None uncommitted. The running VS Code windows only pick up new extension code after a reload (or in a new window).

## Gap list: Portal vs VSCode Portal (Oct 18 2026)

✅ = VSCode Portal has it · ⚠️ = partly · ❌ = missing. Sources: the owner's feature list for the Portal iPhone app, the
old repo, and the VSCode Portal code on branch `screen`.

### Seeing the Mac
- ✅ Live screen, hardware H.264 (native helper `extension/native/portal-helper.swift`, ScreenCaptureKit + VideoToolbox), up to 60 fps
- ✅ Pick a monitor, or **all screens side by side** (helper composites the displays as arranged in System Settings)
- ✅ Pinch zoom, pan while zoomed; ✅ weak connections (ack-based flow control, bitrate steps down/up, skips ahead)
- ✅ Quality slider 30–100%, frame-rate slider 10–60 fps; ✅ status panel (computer, resolution, fps, bitrate, latency) + live latency chip
- ✅ App decodes in its WebView with WebCodecs (works in WKWebView, checked in the iOS Simulator); a native decoder isn't needed

### Mouse, keyboard, clipboard
- ✅ Touch and Trackpad modes, tap/double-tap, right-click (hold or two fingers), hold-and-drag, scroll with momentum
- ✅ Haptics in the app; ✅ keyboard opens/closes with text boxes on the Mac (setting to turn off); ✅ key bar with sticky ⌘⌥⌃⇧
- ✅ Clipboard both ways (in the app a Mac copy lands on the phone automatically)

### Prompt mode: Claude doing things on the Mac
Built Oct 18 (`extension/chats.js`, `extension/agent/`, `extension/native/mac-helper.swift` → `bin/portal-mac`).
Every chat is a saved Claude Code session; each message's mode is **🖥 Mac** (Portal's tools over MCP) or a project mode.
- ✅ Mac-control agent with Portal's tools and system prompt: computer (screenshot, zoom, clicks, drag, scroll, type, keys,
  wait), open/quit/hide apps, open files/folders/links, find files, list windows, window close/minimize/focus/full screen,
  find/press/fill UI elements by name (accessibility), clipboard, volume/mute, brightness, media, look at any monitor or all
- ✅ Screenshots in the chat (live "What I see", send_screenshot, 📸 on demand), full-screen viewer with pinch zoom and Share
- ✅ Terminal approvals (Allow/Deny card; risky commands always ask; setting to auto-approve safe ones); ✅ show-actions glide + ripple
- ✅ Add to a running task (Send becomes "Add"); ✅ several chats at once (they take turns with the mouse/keyboard)
- ✅ Saved chats: searchable list, reopen/continue, swipe to delete, running ones marked; ✅ memory notes + search_chats
- ✅ "End of task" marker; ✅ "Not delivered, tap to send again"
- ✅ Attachments: photos, videos and documents (Mac mode gets pictures/PDFs in the message); uploads resume across dropped
  connections (pieces carry their offset); copies land in Downloads › Portal Uploads
- ✅ Old Portal's chats and notes imported (automatically once; command "VSCode Portal: Import Chats from Portal")

### Siri and Shortcuts
- ❌ "Hey Siri, ask Portal" (runs a task, reads back the reply with a picture); ❌ "Show my Mac's screen" shortcut

### Connection and app
- ✅ From anywhere (relay, E2E encrypted), same Wi-Fi, Tailscale; ✅ pairing key in Keychain/Keystore; ✅ reconnects on return
- ✅ Keeps the phone awake while connected; ✅ warns when mouse/keyboard permission is missing
- ❌ Push notifications ("done", "needs your OK")
- ⚠️ Updates: TestFlight/App Store replace Portal's over-the-air install (by design)
- ❌ Always on: Portal's server runs as a launch agent; VSCode Portal only runs while VS Code is open
- ❌ Funnel/launch-agent migration so the old Portal can be turned off

## Suggested order
1. Diff Portal vs VSCode Portal feature by feature and write the gap list here.
2. Close the biggest gaps: Mac-control agent (not just code prompts), chat history/search/memory, push notifications,
   upload robustness, then the native app parity and over-the-air update path.
3. Migrate the launch agent/Funnel setup so the old Portal can be turned off without losing the phone connection.
   **Never kill the old Portal server while the owner is connected through it.**
