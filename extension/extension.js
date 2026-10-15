'use strict';
// VSCode Portal: connects this VS Code window to the phone client served by server.js.
const vscode = require('vscode');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createPortalServer, findClaude } = require('./server');

let portal = null;
let statusItem = null;
let port = null;

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

async function start(context, host) {
  const cfg = vscode.workspace.getConfiguration('vscodePortal');
  if (!cfg.get('enabled')) return;
  const token = await getToken();
  const claudeBin = cfg.get('claudePath') || findClaude(path.join(os.homedir(), '.vscode', 'extensions'));
  portal = createPortalServer({ host, token, claudeBin, log: (m) => console.log(`[VSCode Portal] ${m}`) });
  try {
    port = await portal.listen(cfg.get('port'), cfg.get('host'));
    statusItem.text = `$(device-mobile) Portal :${port}`;
    statusItem.tooltip = `VSCode Portal is serving this window on port ${port}${claudeBin ? '' : ' (Claude Code not found)'}`;
  } catch (e) {
    statusItem.text = '$(device-mobile) Portal off';
    statusItem.tooltip = `VSCode Portal could not start: ${e.message}`;
  }
  statusItem.show();
}

async function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'vscodePortal.connectInfo';
  context.subscriptions.push(statusItem);
  const host = makeHost(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodePortal.connectInfo', async () => {
      if (!port) return vscode.window.showWarningMessage('VSCode Portal is not running.');
      const link = phoneLink(await getToken());
      const pick = await vscode.window.showInformationMessage(`VSCode Portal is on port ${port}. Open this link on your phone:`, 'Copy Link', 'Open Here');
      if (pick === 'Copy Link') { await vscode.env.clipboard.writeText(link); vscode.window.showInformationMessage('Link copied.'); }
      if (pick === 'Open Here') vscode.env.openExternal(vscode.Uri.parse(link));
    }),
    vscode.commands.registerCommand('vscodePortal.restart', async () => {
      if (portal) await portal.close();
      portal = null; port = null;
      await start(context, host);
    }),
    { dispose: () => portal && portal.close() },
  );
  await start(context, host);
}

function deactivate() { return portal && portal.close(); }

module.exports = { activate, deactivate };
