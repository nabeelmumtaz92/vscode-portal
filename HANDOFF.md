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

## Open work on this branch (uncommitted when this was written)
`extension/screen.js` and `extension/native/portal-helper.swift` have unfinished edits from an earlier chat (the Screen tab).
Review `git diff` before committing; don't discard them blindly.

## Suggested order
1. Diff Portal vs VSCode Portal feature by feature and write the gap list here.
2. Close the biggest gaps: Mac-control agent (not just code prompts), chat history/search/memory, push notifications,
   upload robustness, then the native app parity and over-the-air update path.
3. Migrate the launch agent/Funnel setup so the old Portal can be turned off without losing the phone connection.
   **Never kill the old Portal server while the owner is connected through it.**
