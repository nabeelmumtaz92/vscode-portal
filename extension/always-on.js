'use strict';
// Installs the always-on host (standalone.js) as a login item (launch agent), so the phone reaches the Mac even
// when VS Code is closed. The host's files are copied to a fixed folder so macOS permissions given to it
// stay valid across extension updates; it runs on VS Code's bundled Node.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const LABEL = 'com.vscodeportal.host';
const INSTALL_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'VSCode Portal', 'host');
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'VSCode Portal');
const CONFIG = path.join(os.homedir(), '.vscode-portal', 'always-on.json');
const FILES = ['standalone.js', 'server.js', 'screen.js', 'chats.js', 'relay-host.js', 'agent', 'web', 'bin', 'package.json', 'node_modules/ws'];

const sh = (file, args) => new Promise((resolve) => execFile(file, args, (err, out, errOut) => resolve({ code: err ? err.code || 1 : 0, out: String(out) + String(errOut) })));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const domain = () => `gui/${process.getuid()}`;

const installed = () => fs.existsSync(PLIST);

function copyFiles(extensionPath) {
  fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  for (const f of FILES) {
    const from = path.join(extensionPath, f);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(INSTALL_DIR, f), { recursive: true });
  }
  for (const b of ['portal-helper', 'portal-mac']) { try { fs.chmodSync(path.join(INSTALL_DIR, 'bin', b), 0o755); } catch {} }
  fs.writeFileSync(path.join(INSTALL_DIR, 'VERSION'), require(path.join(extensionPath, 'package.json')).version);
}

async function install({ extensionPath, nodePath = process.execPath, relayUrl, claudePath }) {
  copyFiles(extensionPath);
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG, JSON.stringify({ relayUrl: relayUrl || '', claudePath: claudePath || '' }, null, 2), { mode: 0o600 });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(nodePath)}</string><string>${esc(path.join(INSTALL_DIR, 'standalone.js'))}</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>ELECTRON_RUN_AS_NODE</key><string>1</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WorkingDirectory</key><string>${esc(os.homedir())}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${esc(path.join(LOG_DIR, 'host.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(LOG_DIR, 'host.log'))}</string>
</dict></plist>
`);
  await sh('/bin/launchctl', ['bootout', `${domain()}/${LABEL}`]);
  const r = await sh('/bin/launchctl', ['bootstrap', domain(), PLIST]);
  if (r.code) throw new Error(`launchctl couldn't start it: ${r.out.trim()}`);
}

async function uninstall() {
  await sh('/bin/launchctl', ['bootout', `${domain()}/${LABEL}`]);
  fs.rmSync(PLIST, { force: true });
}

// After the extension updates, the installed host gets the new files and restarts
async function refresh({ extensionPath, nodePath = process.execPath }) {
  if (!installed()) return false;
  const version = require(path.join(extensionPath, 'package.json')).version;
  let have = '';
  try { have = fs.readFileSync(path.join(INSTALL_DIR, 'VERSION'), 'utf8').trim(); } catch {}
  if (have === version) return false;
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch {}
  await install({ extensionPath, nodePath, ...cfg });
  return true;
}

const restart = () => sh('/bin/launchctl', ['kickstart', '-k', `${domain()}/${LABEL}`]);

module.exports = { install, uninstall, refresh, restart, installed, LABEL, LOG_DIR };
