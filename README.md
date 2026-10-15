# VSCode Portal

VS Code + Portal: use a real VS Code window on your Mac from your iPhone, with **Claude Code prompts** built in.
Instead of streaming video, it sends structured data, so it is fast and crisp on cellular.

- **✨ Prompt:** Claude Code runs headless in the project (your existing Claude login). You see its replies stream in, tool cards for each edit/command (tap for the diff), and the cost and duration. Chats continue across prompts; "New chat" starts fresh. Modes:
  - **Auto-edit:** edits files and runs safe commands (git status/diff/add/commit/push, npm test/build/lint, tsc).
  - **Full access:** anything (bypass permissions).
  - **Plan only:** read and plan, no changes.
  Tap 📎 to include the file and selection you're looking at.
- **Files / Editor:** browse and search the workspace, edit in CodeMirror with a symbol key row. Edits go live into the VS Code window on the Mac (and Mac edits show on the phone). "Follow" tracks the file open on the Mac; 🖥 opens it there.
- **Changes:** git branch and changed files with diffs, Commit / Push, "✨ Commit & push" via Claude, and VS Code's Problems with "Ask Claude to fix".
- **Terminal:** run commands with output on the phone, or send them to the VS Code terminal on the Mac (watch it in Portal).

## How it fits together

```
iPhone (web app)  ── WebSocket (JSON) ──▶  VS Code extension (server.js inside the extension host)
                                             ├─ VS Code API: documents, tabs, diagnostics, terminal
                                             ├─ git / zsh for Changes and Terminal
                                             └─ claude -p --output-format stream-json  (Prompt)
```

| Path | What it is |
|---|---|
| `extension/extension.js` | VS Code side: live document sync, tabs, problems, terminal, status bar |
| `extension/server.js` | HTTP + WebSocket API, auth, git, commands, Claude Code runner (testable without VS Code) |
| `extension/web/` | The phone app (installable to the Home Screen) |
| `extension/src/editor-entry.js` | CodeMirror wrapper, bundled to `web/editor.bundle.js` |

## Setup

```bash
scripts/install.sh            # build, package, install into VS Code; then reload VS Code windows
```

Each VS Code window serves on port 7788, the next window on 7789, and so on (see the **Portal :port** status bar item).
The access code lives in `~/.vscode-portal/token`. Click the status bar item to copy the phone link.

To reach it from the phone, publish it on your tailnet (private, not public):

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=8443 http://127.0.0.1:7788
```

Then set `vscodePortal.publicUrl` to `https://<your-mac>.<tailnet>.ts.net:8443`, open the link on the iPhone and Share → Add to Home Screen.

## Tests

```bash
cd extension && npm test
```
