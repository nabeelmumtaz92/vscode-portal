'use strict';
// VSCode Portal: connects this VS Code window to the phone client served by server.js.
const vscode = require('vscode');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const { createPortalServer, findClaude } = require('./server');
const { connectRelay } = require('./relay-host');
const { createScreen } = require('./screen');
const alwaysOn = require('./always-on');
const E2E = require('./web/e2e.js');

let portal = null;
let statusItem = null;
let port = null;
let wifiUrl = null; // http://<wifi-ip>:<port> when same-Wi-Fi access is on
let relay = null;
let screen = null; // shared by restarts, so a running capture keeps going

function commonEdit(doc, text) {
  // Replace only the part that changed, so the cursor on the Mac stays put.
  const old = doc.getText();
  let start = 0;
  const max = Math.min(old.length, text.length);
  while (start < max && old.charCodeAt(start) === text.charCodeAt(start)) start++;
  let endOld = old.length, endNew = text.length;
  while (endOld > start && endNew > start && old.charCodeAt(endOld - 1) === text.charCodeAt(endNew - 1)) { endOld--; endNew--; }
  return { range: new vscode.Range(doc.positionAt(start), doc.positionAt(endOld)), text: text.slice(start, endNew) };
}

function makeHost(context) {
  const emitter = new vscode.EventEmitter();
  const writing = new Map(); // path -> client id currently writing it
  const isFile = (uri) => uri && uri.scheme === 'file';
  const host = {
    workspaceName: () => vscode.workspace.name || 'No folder open',
    folders: () => (vscode.workspace.workspaceFolders || []).map(f => ({ name: f.name, path: f.uri.fsPath })),
    activeFile() {
      const e = vscode.window.activeTextEditor;
      return e && isFile(e.document.uri) ? { path: e.document.uri.fsPath, line: e.selection.active.line + 1 } : null;
    },
    openTabs: () => vscode.window.tabGroups.all.flatMap(g => g.tabs)
      .map(t => t.input && isFile(t.input.uri) ? t.input.uri.fsPath : null).filter(Boolean),
    async readDoc(p) {
      const doc = vscode.workspace.textDocuments.find(d => isFile(d.uri) && d.uri.fsPath === p);
      return doc ? { text: doc.getText(), language: doc.languageId, dirty: doc.isDirty } : null;
    },
    async writeDoc(p, text, { origin, save }) {
      const uri = vscode.Uri.file(p);
      const doc = await vscode.workspace.openTextDocument(uri);
      if (doc.getText() !== text) {
        const { range, text: piece } = commonEdit(doc, text);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, range, piece);
        writing.set(p, origin);
        try { await vscode.workspace.applyEdit(edit); } finally { writing.delete(p); }
      }
      if (save) await doc.save();
      return { dirty: doc.isDirty };
    },
    async reveal(p, line) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
      const ed = await vscode.window.showTextDocument(doc, { preview: false });
      if (line) {
        const pos = new vscode.Position(Math.max(0, line - 1), 0);
        ed.selection = new vscode.Selection(pos, pos);
        ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    },
    diagnostics() {
      const sev = ['error', 'warning', 'info', 'hint'];
      const out = [];
      for (const [uri, list] of vscode.languages.getDiagnostics()) {
        if (!isFile(uri)) continue;
        for (const d of list) {
          if (d.severity > 1) continue;
          out.push({ path: uri.fsPath, line: d.range.start.line + 1, severity: sev[d.severity], message: d.message, source: d.source || '' });
          if (out.length >= 300) return out;
        }
      }
      return out.sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1));
    },
    sendToTerminal(text) {
      const t = vscode.window.terminals.find(x => x.name === 'VSCode Portal') || vscode.window.createTerminal('VSCode Portal');
      t.show(true);
      t.sendText(text);
    },
    async findFiles(q) {
      const uris = await vscode.workspace.findFiles(`**/*${q}*`, '**/{node_modules,.git,dist,build,Pods,.expo}/**', 60);
      return uris.map(u => u.fsPath);
    },
    onEvent: (cb) => emitter.event(cb),
  };

  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const disk = (uri) => isFile(uri) && emitter.fire({ type: 'disk', path: uri.fsPath });
  context.subscriptions.push(
    emitter, watcher,
    watcher.onDidChange(disk), watcher.onDidCreate(disk), watcher.onDidDelete(disk),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (!isFile(e.document.uri) || !e.contentChanges.length) return;
      const p = e.document.uri.fsPath;
      emitter.fire({ type: 'doc', path: p, text: () => e.document.getText(), dirty: e.document.isDirty, origin: writing.get(p) });
    }),
    vscode.workspace.onDidSaveTextDocument(d => emitter.fire({ type: 'saved', path: d.uri.fsPath })),
    vscode.window.onDidChangeActiveTextEditor(() => emitter.fire({ type: 'active', active: host.activeFile(), tabs: host.openTabs() })),
  );
  return host;
}

async function getToken() {
  // One code shared by every VS Code window, kept in ~/.vscode-portal/token.
  const fromSettings = vscode.workspace.getConfiguration('vscodePortal').get('token');
  if (fromSettings) return fromSettings;
  const fs = require('fs');
  const dir = path.join(os.homedir(), '.vscode-portal');
  const file = path.join(dir, 'token');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, crypto.randomBytes(12).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (e) { if (e.code !== 'EEXIST') throw e; }
  return fs.readFileSync(file, 'utf8').trim();
}

function phoneLink(token) {
  const cfg = vscode.workspace.getConfiguration('vscodePortal');
  const base = (cfg.get('publicUrl') || `http://127.0.0.1:${port}`).replace(/\/$/, '');
  return `${base}/#token=${token}`;
}

const PORTAL_DIR = path.join(os.homedir(), '.vscode-portal');

// Pairing key + room for the relay, shared by every VS Code window. Phones get it from the QR code.
function getPairing(reset = false) {
  const file = path.join(PORTAL_DIR, 'pairing.json');
  fs.mkdirSync(PORTAL_DIR, { recursive: true, mode: 0o700 });
  if (!reset) { try { const p = JSON.parse(fs.readFileSync(file, 'utf8')); if (p.key && p.room) return p; } catch {} }
  const p = { key: E2E.newKey(), room: E2E.newRoom() };
  fs.writeFileSync(file, JSON.stringify(p), { mode: 0o600 });
  return p;
}
// Stable id for this window's workspace, so the phone reconnects to the same one.
const hostIdFor = () => crypto.createHash('sha256')
  .update(`${os.hostname()}|${(vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath).join('|') || vscode.workspace.name || 'empty'}`)
  .digest('hex').slice(0, 32);

function wifiAddress() {
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(utun|tailscale|lo|bridge|awdl|llw|vmnet)/.test(name)) continue;
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('100.') && !a.address.startsWith('169.254.')) return a.address;
    }
  }
  return null;
}

function updateStatus(claudeBin) {
  if (!port) return;
  const ways = [];
  if (relay) ways.push(relay.state === 'online' ? 'anywhere (relay)' : `relay ${relay.state}`);
  if (wifiUrl) ways.push('same Wi-Fi');
  const cfg = vscode.workspace.getConfiguration('vscodePortal');
  if (cfg.get('publicUrl')) ways.push('Tailscale');
  statusItem.text = `$(device-mobile) Portal :${port}`;
  statusItem.tooltip = `VSCode Portal is serving this window on port ${port}` +
    (ways.length ? `\nPhones can connect: ${ways.join(', ')}` : '') +
    (claudeBin === null ? '\n(Claude Code not found)' : '') + '\nClick to connect a phone.';
}

async function start(context, host) {
  const cfg = vscode.workspace.getConfiguration('vscodePortal');
  if (!cfg.get('enabled')) return;
  const token = await getToken();
  const claudeBin = cfg.get('claudePath') || findClaude(path.join(os.homedir(), '.vscode', 'extensions'));
  portal = createPortalServer({ host, token, claudeBin, useApiKey: !!cfg.get('useApiKey'), screen, log: (m) => console.log(`[VSCode Portal] ${m}`) });
  try {
    port = await portal.listen(cfg.get('port'), cfg.get('host'));
    wifiUrl = null;
    const ip = cfg.get('wifi') && wifiAddress();
    if (ip) {
      try { await portal.listenAlso(port, ip); wifiUrl = `http://${ip}:${port}`; }
      catch (e) { console.log(`[VSCode Portal] Wi-Fi access failed: ${e.message}`); }
    }
    const relayUrl = (cfg.get('relayUrl') || '').trim();
    if (relayUrl) {
      relay = connectRelay({
        relayUrl, pairing: getPairing(), hostId: hostIdFor(), portal,
        label: () => ({ name: vscode.workspace.name || 'VS Code', computer: os.hostname().replace(/\.local$/, '') }),
        log: (m) => console.log(`[VSCode Portal] ${m}`),
      });
      relay.onState(() => updateStatus(claudeBin));
    }
    updateStatus(claudeBin);
    importPortalOnce();
  } catch (e) {
    statusItem.text = '$(device-mobile) Portal off';
    statusItem.tooltip = `VSCode Portal could not start: ${e.message}`;
  }
  statusItem.show();
}

// Moving from the old Portal app: bring its chats and notes over once (VSCode Portal: Import Chats from Portal re-runs it)
function importPortalOnce() {
  const marker = path.join(PORTAL_DIR, '.imported-portal');
  if (fs.existsSync(marker) || !fs.existsSync(path.join(os.homedir(), '.config', 'portal', 'chats')) || !portal) return;
  try {
    const r = portal.chats.importPortal();
    fs.writeFileSync(marker, new Date().toISOString());
    if (r.chats) vscode.window.showInformationMessage(`VSCode Portal brought over ${r.chats} chats and ${r.notes} notes from Portal.`);
  } catch (e) { console.log(`[VSCode Portal] import from Portal failed: ${e.message}`); }
}

async function showConnectPanel() {
  if (!port) return vscode.window.showWarningMessage('VSCode Portal is not running.');
  const QR = require('qrcode');
  const cfg = vscode.workspace.getConfiguration('vscodePortal');
  const token = await getToken();
  const ways = [];
  const relayUrl = (cfg.get('relayUrl') || '').trim().replace(/\/$/, '');
  if (relayUrl) {
    const p = getPairing();
    ways.push({ title: 'From anywhere', note: 'Works on cellular or any Wi-Fi. End-to-end encrypted through the relay. Scan once; the phone stays paired.', link: `${relayUrl}/#pair=${p.key}.${p.room}` });
  }
  if (wifiUrl) ways.push({ title: 'Same Wi-Fi', note: 'Your phone must be on the same Wi-Fi as this computer.', link: `${wifiUrl}/#token=${token}` });
  if (cfg.get('publicUrl')) ways.push({ title: 'Tailscale', note: 'Your phone must be signed in to Tailscale.', link: phoneLink(token) });
  const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  let body = '';
  for (const w of ways) {
    const svg = await QR.toString(w.link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    body += `<section><h2>${esc(w.title)}</h2><p>${esc(w.note)}</p><div class="qr">${svg}</div>
      <button data-link="${esc(w.link)}">Copy link</button></section>`;
  }
  if (!ways.length) {
    body = `<section><h2>Turn on a way to connect</h2><p>In Settings, search for <b>VSCode Portal</b> and turn on <b>Wifi</b> (same Wi-Fi), set a <b>Relay Url</b> (from anywhere), or set a <b>Public Url</b> (Tailscale).</p>
      <button data-settings="1">Open Settings</button></section>`;
  }
  const panel = vscode.window.createWebviewPanel('vscodePortal.connect', 'Connect Phone', vscode.ViewColumn.Active, { enableScripts: true });
  const nonce = crypto.randomBytes(16).toString('hex');
  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';">
<style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:20px;max-width:900px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--vscode-descriptionForeground);margin:0 0 20px}
.grid{display:flex;flex-wrap:wrap;gap:20px}section{border:1px solid var(--vscode-panel-border);border-radius:10px;padding:16px;width:260px}
h2{font-size:15px;margin:0 0 6px}p{font-size:12.5px;color:var(--vscode-descriptionForeground);min-height:48px}
.qr{background:#fff;padding:10px;border-radius:8px}.qr svg{display:block;width:100%;height:auto}
button{margin-top:12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:6px 12px;border-radius:4px;cursor:pointer}</style></head>
<body><h1>📱 Connect your phone</h1><p class="sub">Scan with your iPhone camera. The link contains your access key, so don't share it.</p><div class="grid">${body}</div>
<script nonce="${nonce}">const vs=acquireVsCodeApi();document.querySelectorAll('button').forEach(b=>b.onclick=()=>vs.postMessage(b.dataset));</script></body></html>`;
  panel.webview.onDidReceiveMessage(async (m) => {
    if (m.link) { await vscode.env.clipboard.writeText(m.link); vscode.window.showInformationMessage('Link copied.'); }
    if (m.settings) vscode.commands.executeCommand('workbench.action.openSettings', 'vscodePortal');
  });
}

async function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'vscodePortal.connectInfo';
  context.subscriptions.push(statusItem);
  const host = makeHost(context);
  screen = createScreen({
    helperPath: path.join(context.extensionPath, 'bin', 'portal-helper'),
    enabled: () => vscode.workspace.getConfiguration('vscodePortal').get('screen'),
    log: (m) => console.log(`[VSCode Portal] ${m}`),
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodePortal.enableScreen', async () => {
      if (process.platform !== 'darwin') return vscode.window.showWarningMessage('Screen sharing needs a Mac.');
      const ok = await vscode.window.showWarningMessage(
        'Let your paired phones see this Mac\'s screen and control its mouse and keyboard?',
        { modal: true, detail: 'macOS will ask you to allow Screen Recording and Accessibility for Visual Studio Code. You can turn this off any time in Settings › VSCode Portal › Screen.' },
        'Turn On');
      if (ok !== 'Turn On') return;
      await vscode.workspace.getConfiguration('vscodePortal').update('screen', true, vscode.ConfigurationTarget.Global);
      screen.requestPermissions();
      vscode.window.showInformationMessage('Screen sharing is on. If macOS asked for permissions, allow them, then quit and reopen VS Code.');
    }),
    vscode.commands.registerCommand('vscodePortal.connectInfo', () => showConnectPanel()),
    vscode.commands.registerCommand('vscodePortal.alwaysOn', async () => {
      if (process.platform !== 'darwin') return vscode.window.showWarningMessage('Always on needs a Mac.');
      if (alwaysOn.installed()) {
        const off = await vscode.window.showInformationMessage('VSCode Portal keeps running when VS Code is closed.', 'Turn Off', 'Restart It', 'Show Log');
        if (off === 'Turn Off') { await alwaysOn.uninstall(); vscode.window.showInformationMessage('Turned off. The phone reaches the Mac only while VS Code is open.'); }
        if (off === 'Restart It') await alwaysOn.restart();
        if (off === 'Show Log') vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(alwaysOn.LOG_DIR, 'host.log')));
        return;
      }
      const cfg = vscode.workspace.getConfiguration('vscodePortal');
      const ok = await vscode.window.showInformationMessage(
        'Keep VSCode Portal running when VS Code is closed?',
        { modal: true, detail: 'A small login item keeps the phone connected to this Mac all the time (Screen, Files, Terminal and Claude on the Mac). It shows in the phone\'s window list as this Mac "(always on)". macOS will ask once to allow Screen Recording and Accessibility for "Code Helper (Plugin)".' },
        'Keep Running');
      if (ok !== 'Keep Running') return;
      try {
        await alwaysOn.install({ extensionPath: context.extensionPath, relayUrl: (cfg.get('relayUrl') || '').trim(), claudePath: cfg.get('claudePath') || '' });
        vscode.window.showInformationMessage('VSCode Portal now keeps running when VS Code is closed.');
      } catch (e) { vscode.window.showErrorMessage(`Couldn't set it up: ${e.message}`); }
    }),
    vscode.commands.registerCommand('vscodePortal.importPortal', () => {
      if (!portal) return vscode.window.showWarningMessage('VSCode Portal is not running.');
      const r = portal.chats.importPortal();
      vscode.window.showInformationMessage(r.chats || r.notes ? `Brought over ${r.chats} chats and ${r.notes} notes from Portal.` : 'Everything from Portal is already here.');
    }),
    vscode.commands.registerCommand('vscodePortal.resetPairing', async () => {
      const ok = await vscode.window.showWarningMessage('Unpair all phones? They will need to scan the new QR code.', { modal: true }, 'Unpair');
      if (ok !== 'Unpair') return;
      getPairing(true);
      await vscode.commands.executeCommand('vscodePortal.restart');
      if (alwaysOn.installed()) await alwaysOn.restart(); // the always-on host picks up the new pairing
      vscode.window.showInformationMessage('All phones unpaired. Reload your other VS Code windows too.');
    }),
    vscode.commands.registerCommand('vscodePortal.restart', async () => {
      if (relay) relay.close();
      if (portal) await portal.close();
      portal = null; port = null; relay = null; wifiUrl = null;
      await start(context, host);
    }),
    { dispose: () => { if (relay) relay.close(); if (portal) portal.close(); if (screen) screen.close(); } },
  );
  await start(context, host);
  // An installed always-on host gets this version's files
  alwaysOn.refresh({ extensionPath: context.extensionPath }).catch((e) => console.log(`[VSCode Portal] always-on update failed: ${e.message}`));
}

function deactivate() { if (relay) relay.close(); if (screen) screen.close(); return portal && portal.close(); }

module.exports = { activate, deactivate };
