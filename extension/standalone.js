'use strict';
// Always-on host: the same Portal server, running without VS Code (started at login by a launch agent, see
// always-on.js). It shows up in the phone's window list as the Mac itself, with Files over the home folder,
// Terminal, Screen and the Mac agent, so the phone can reach the Mac even when VS Code is closed.
//
// Run by VS Code's bundled Node (ELECTRON_RUN_AS_NODE=1). Settings: ~/.vscode-portal/always-on.json
// ({ relayUrl, port }). Pairing and access code are shared with the extension (~/.vscode-portal).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { createPortalServer, findClaude } = require('./server');
const { createScreen } = require('./screen');
const { connectRelay } = require('./relay-host');

const DIR = path.join(os.homedir(), '.vscode-portal');
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const config = (() => { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'always-on.json'), 'utf8')); } catch { return {}; } })();
const HOME = os.homedir();
const computer = os.hostname().replace(/\.local$/, '');

function token() {
  const file = path.join(DIR, 'token');
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(file, crypto.randomBytes(12).toString('hex'), { flag: 'wx', mode: 0o600 }); } catch {}
  return fs.readFileSync(file, 'utf8').trim();
}
function pairing() {
  try { const p = JSON.parse(fs.readFileSync(path.join(DIR, 'pairing.json'), 'utf8')); if (p.key && p.room) return p; } catch {}
  return null;
}

// What the extension gets from VS Code, done directly on the Mac instead
const listeners = [];
const host = {
  workspaceName: () => `${computer} (always on)`,
  folders: () => [{ name: 'Home', path: HOME }],
  activeFile: () => null,
  openTabs: () => [],
  readDoc: async () => null,
  async writeDoc(p, text, { save }) { if (save) await fs.promises.writeFile(p, text); else await fs.promises.writeFile(p, text); return { dirty: false }; },
  async reveal(p) { execFile('/usr/bin/open', [p], () => {}); },
  diagnostics: () => [],
  sendToTerminal(text) {
    // No VS Code terminal here: run it in Terminal.app
    const script = `tell application "Terminal" to do script ${JSON.stringify(text)}`;
    execFile('/usr/bin/osascript', ['-e', script, '-e', 'tell application "Terminal" to activate'], () => {});
  },
  findFiles: (q) => new Promise((resolve) => execFile('/usr/bin/mdfind', ['-onlyin', HOME, `kMDItemFSName == "*${String(q).replace(/["\\]/g, '')}*"c`],
    { maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? [] : String(out).split('\n').filter(Boolean).filter((p) => !/\/(Library|node_modules|\.git)\//.test(p)).slice(0, 60)))),
  onEvent: (cb) => { listeners.push(cb); return { dispose() {} }; },
};

(async () => {
  const screen = createScreen({ helperPath: path.join(__dirname, 'bin', 'portal-helper'), enabled: () => true, log });
  const claudeBin = config.claudePath || findClaude(path.join(HOME, '.vscode', 'extensions'));
  const portal = createPortalServer({ host, token: token(), claudeBin, screen, macBinary: path.join(__dirname, 'bin', 'portal-mac'), log });
  const port = await portal.listen(config.port || 7787, '127.0.0.1');
  log(`always-on host on 127.0.0.1:${port}${claudeBin ? '' : ' (Claude Code not found)'}`);
  // Ask macOS for Screen Recording and Accessibility once (the prompts name "Code Helper (Plugin)")
  screen.requestPermissions();

  let relay = null;
  const p = pairing();
  if (config.relayUrl && p) {
    relay = connectRelay({
      relayUrl: config.relayUrl, pairing: p, portal, log,
      hostId: crypto.createHash('sha256').update(`${os.hostname()}|always-on`).digest('hex').slice(0, 32),
      label: () => ({ name: `${computer} (always on)`, computer }),
    });
    relay.onState((s) => log(`relay ${s}`));
  } else log('no relay configured or no pairing yet; reachable on this Mac only');

  const shutdown = async () => { if (relay) relay.close(); screen.close(); await portal.close(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})().catch((e) => { log(`failed: ${e.stack || e}`); process.exit(1); });
