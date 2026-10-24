'use strict';
// VSCode Portal server: serves the phone client and a JSON WebSocket API on top of a VS Code window.
// `host` adapts VS Code (see extension.js); tests pass a fake one.
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const { createChats } = require('./chats');
const { createMac, screenshot } = require('./agent/mac');
const { createMcpServer } = require('./agent/mcp');

const WEB_DIR = path.join(__dirname, 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
};
const HIDDEN = new Set(['.git', 'node_modules', '.DS_Store', '.expo', 'Pods', 'DerivedData', '.next', '.venv', '__pycache__']);
const MAX_FILE = 2 * 1024 * 1024;
const MAX_RUN_OUTPUT = 256 * 1024;
// In "Auto-edit" mode Claude may edit files and run these without asking; anything else is denied.
const SAFE_TOOLS = [
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git add:*)',
  'Bash(git commit:*)', 'Bash(git push)', 'Bash(git branch:*)', 'Bash(ls:*)', 'Bash(npm test:*)',
  'Bash(npm run lint:*)', 'Bash(npm run build:*)', 'Bash(npm run typecheck:*)', 'Bash(npx tsc:*)',
];

function tokensMatch(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

const execP = (file, args, cwd) => new Promise(resolve =>
  execFile(file, args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) =>
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })));

const UPLOAD_DIR = path.join(os.homedir(), '.vscode-portal', 'uploads');
const MAX_UPLOAD = 500 * 1024 * 1024;
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.3gp']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif']);
function findBin(name) {
  for (const d of [...(process.env.PATH || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    try { const p = path.join(d, name); fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

function createPortalServer({ host, token, claudeBin, useApiKey = false, aiMode = 'free', screen = null, macBinary = path.join(__dirname, 'bin', 'portal-mac'), log = () => {} }) {
  const clients = new Set();
  const uploads = new Map();
  const failures = new Map(); // ip -> { count, since }
  const runs = new Map();
  let nextClient = 1;
  let nextRun = 1;

  const broadcast = (msg) => {
    const s = JSON.stringify(msg);
    for (const c of clients) if (c.authed && c.ws.readyState === 1) c.ws.send(s);
  };

  const roots = () => host.folders().map(f => path.resolve(f.path));
  const mac = createMac(macBinary);
  const mcp = createMcpServer();
  const chats = createChats({ claudeBin, macBinary, mac, mcp, roots, uploadDir: UPLOAD_DIR, useApiKey, aiMode, broadcast, log });
  function inside(p) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Bad path');
    const abs = path.resolve(p);
    if (!roots().some(r => abs === r || abs.startsWith(r + path.sep))) throw new Error('That file is outside the workspace');
    return abs;
  }
  function rootOf(p) {
    const all = roots();
    if (!p) return all[0];
    const abs = path.resolve(p);
    return all.filter(r => abs === r || abs.startsWith(r + path.sep)).sort((a, b) => b.length - a.length)[0] || all[0];
  }
  async function gitTop(dir) {
    const r = await execP('git', ['rev-parse', '--show-toplevel'], dir);
    return r.code ? null : r.stdout.trim();
  }

  function hello() {
    return {
      workspace: host.workspaceName(), folders: host.folders(), active: host.activeFile(), tabs: host.openTabs(),
      chats: { running: chats.running(), settings: chats.settings(), mac: process.platform === 'darwin' },
      claude: !!claudeBin, home: os.homedir(), screen: screen ? screen.status() : null,
    };
  }

  const handlers = {
    async tree({ path: p }) {
      const dir = inside(p);
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries.filter(e => !HIDDEN.has(e.name))
        .map(e => ({ name: e.name, path: path.join(dir, e.name), dir: e.isDirectory() }))
        .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    },
    async find({ q }) {
      const clean = String(q || '').replace(/[^\w.\-]/g, '');
      return clean ? host.findFiles(clean) : [];
    },
    async read({ path: p }, client) {
      const abs = inside(p);
      client.watching = abs;
      const open = await host.readDoc(abs);
      if (open) return { path: abs, ...open };
      const st = await fsp.stat(abs);
      if (st.size > MAX_FILE) throw new Error('File is too large to edit on the phone');
      const buf = await fsp.readFile(abs);
      if (buf.includes(0)) throw new Error("That's a binary file");
      return { path: abs, text: buf.toString('utf8'), dirty: false };
    },
    async write({ path: p, text, save }, client) {
      if (typeof text !== 'string') throw new Error('Missing text');
      return host.writeDoc(inside(p), text, { origin: client.id, save: !!save });
    },
    async reveal({ path: p, line }) { await host.reveal(inside(p), line); return true; },
    async diagnostics() { return host.diagnostics(); },
    async 'terminal.send'({ text }) { host.sendToTerminal(String(text || '')); return true; },

    async run({ command, cwd }) {
      if (!command) throw new Error('Missing command');
      const id = String(nextRun++);
      const dir = cwd ? inside(cwd) : (roots()[0] || os.homedir());
      const isWin = process.platform === 'win32';
      const proc = spawn(isWin ? 'powershell.exe' : '/bin/zsh', isWin ? ['-NoProfile', '-Command', String(command)] : ['-lc', String(command)], {
        cwd: dir, detached: !isWin, windowsHide: true, env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
      });
      const r = { id, command, proc, output: '' };
      const onData = d => {
        const s = d.toString();
        r.output = (r.output + s).slice(-MAX_RUN_OUTPUT);
        broadcast({ type: 'run.out', runId: id, data: s });
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', e => onData(`\n${e.message}\n`));
      proc.on('close', code => {
        r.proc = null;
        broadcast({ type: 'run.exit', runId: id, code });
        setTimeout(() => runs.delete(id), 10 * 60 * 1000).unref?.();
      });
      runs.set(id, r);
      return { runId: id, cwd: dir };
    },
    async 'run.kill'({ runId }) {
      const r = runs.get(String(runId));
      if (r && r.proc) { try { process.kill(-r.proc.pid, 'SIGTERM'); } catch { r.proc.kill('SIGTERM'); } }
      return true;
    },

    async 'git.status'() {
      const seen = new Set();
      const repos = [];
      for (const root of roots()) {
        const top = await gitTop(root);
        if (!top || seen.has(top)) continue;
        seen.add(top);
        const r = await execP('git', ['status', '--porcelain=v1', '-b'], top);
        if (r.code) continue;
        const lines = r.stdout.split('\n').filter(Boolean);
        const head = (lines[0] || '').replace(/^## /, '');
        const branch = head.split('...')[0].replace(/^No commits yet on /, '');
        const ahead = +(head.match(/ahead (\d+)/) || [0, 0])[1];
        const behind = +(head.match(/behind (\d+)/) || [0, 0])[1];
        const files = lines.slice(1).map(l => {
          let rel = l.slice(3);
          if (rel.includes(' -> ')) rel = rel.split(' -> ').pop();
          rel = rel.replace(/^"|"$/g, '');
          return { status: l.slice(0, 2), rel, path: path.join(top, rel) };
        });
        repos.push({ root: top, name: path.basename(top), branch, ahead, behind, files });
      }
      return repos;
    },
    async 'git.diff'({ path: p }) {
      const abs = inside(p);
      const top = await gitTop(path.dirname(abs));
      if (!top) throw new Error('Not in a git repo');
      let r = await execP('git', ['diff', 'HEAD', '--', abs], top);
      if (r.code || !r.stdout.trim()) r = await execP('git', ['diff', '--', abs], top);
      if (!r.stdout.trim()) r = await execP('git', ['diff', '--no-index', '--', '/dev/null', abs], top);
      return r.stdout || '(no changes)';
    },
    async 'git.commit'({ root, message }) {
      const top = await gitTop(inside(root));
      if (!message || !String(message).trim()) throw new Error('Commit message is empty');
      const add = await execP('git', ['add', '-A'], top);
      if (add.code) throw new Error(add.stderr || 'git add failed');
      const r = await execP('git', ['commit', '-m', String(message)], top);
      if (r.code) throw new Error((r.stdout + r.stderr).trim() || 'git commit failed');
      return r.stdout.trim();
    },
    async 'git.push'({ root }) {
      const top = await gitTop(inside(root));
      const r = await execP('git', ['push'], top);
      if (r.code) throw new Error((r.stdout + r.stderr).trim() || 'git push failed');
      return (r.stdout + r.stderr).trim() || 'Pushed';
    },

    // ---- attachments: phone uploads images/videos in chunks; videos become frames Claude can Read ----
    async 'attach.begin'({ name, size }) {
      if (!(size <= MAX_UPLOAD)) throw new Error('File too large (500 MB max)');
      const id = crypto.randomBytes(6).toString('hex');
      const dir = path.join(UPLOAD_DIR, id);
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      const safe = path.basename(String(name || 'file')).replace(/[^\w.\- ]/g, '_').slice(-80) || 'file';
      const file = path.join(dir, safe);
      uploads.set(id, { dir, file, name: safe, got: 0, size });
      await fsp.writeFile(file, '');
      return { id };
    },
    // offset makes a resent piece harmless: the phone learns how much arrived and carries on from there
    // (The upload's id travels as `upload`: `id` is the request's own id)
    async 'attach.chunk'({ upload: id, data, offset }) {
      const u = uploads.get(id); if (!u) throw new Error('Unknown upload');
      if (offset !== undefined && offset !== u.got) return { got: u.got };
      const buf = Buffer.from(String(data), 'base64');
      u.got += buf.length;
      if (u.got > MAX_UPLOAD) throw new Error('File too large');
      await fsp.appendFile(u.file, buf);
      return offset !== undefined ? { got: u.got } : u.got;
    },
    async 'attach.end'({ upload: id }) {
      const u = uploads.get(id); if (!u) throw new Error('Unknown upload');
      const ext = path.extname(u.name).toLowerCase();
      const out = { id, name: u.name, path: u.file, kind: 'file', frames: [], note: '' };
      if (IMAGE_EXT.has(ext)) {
        out.kind = 'image';
        if (ext === '.heic' || ext === '.heif') {
          const jpg = path.join(u.dir, u.name.replace(/\.[^.]+$/, '') + '.jpg');
          const r = await execP('/usr/bin/sips', ['-s', 'format', 'jpeg', u.file, '--out', jpg]);
          if (!r.code) out.path = jpg;
        }
      } else if (VIDEO_EXT.has(ext)) {
        out.kind = 'video';
        const ffmpeg = findBin('ffmpeg'), ffprobe = findBin('ffprobe');
        if (!ffmpeg) throw new Error('ffmpeg not found on the Mac (brew install ffmpeg) so videos cannot be viewed');
        let dur = 0;
        if (ffprobe) {
          const r = await execP(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', u.file]);
          dur = parseFloat(r.stdout) || 0;
        }
        const n = dur ? Math.min(16, Math.max(4, Math.round(dur))) : 8;
        out.duration = dur;
        for (let i = 0; i < n; i++) {
          const t = dur ? ((i + 0.5) * dur) / n : i * 2;
          const f = path.join(u.dir, `frame_${String(i + 1).padStart(2, '0')}.jpg`);
          const r = await execP(ffmpeg, ['-v', 'error', '-y', '-ss', t.toFixed(2), '-i', u.file, '-frames:v', '1',
            '-vf', "scale='min(960,iw)':-2", '-q:v', '4', f]);
          if (!r.code && fs.existsSync(f)) out.frames.push({ path: f, t: +t.toFixed(1) });
        }
        if (!out.frames.length) throw new Error('Could not read frames from that video');
        const hasAudio = ffprobe && (await execP(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', u.file])).stdout.trim();
        out.note = hasAudio ? 'It has an audio track, which you cannot hear.' : '';
      }
      u.info = out;
      // A copy for the user, like Portal: ~/Downloads/Portal Uploads (never overwriting)
      if (!process.env.VSP_NO_DOWNLOADS_COPY) {
        try {
          const dest = path.join(os.homedir(), 'Downloads', 'Portal Uploads');
          await fsp.mkdir(dest, { recursive: true });
          const ext = path.extname(u.name), stem = path.basename(u.name, ext);
          let target = path.join(dest, u.name);
          for (let n = 2; fs.existsSync(target); n++) target = path.join(dest, `${stem} ${n}${ext}`);
          await fsp.copyFile(u.file, target);
        } catch {}
      }
      return { id, name: out.name, kind: out.kind, frames: out.frames.length, duration: out.duration || 0 };
    },

    // ---- chats (see chats.js): several at once, saved and searchable; Mac mode controls the Mac ----
    async 'chat.list'({ query }) { return chats.list(query); },
    async 'chat.open'({ chat, limit }) {
      const c = chats.open(chat, { limit: Math.min(2000, Number(limit) || 120) });
      if (!c) throw new Error('That chat doesn\'t exist anymore.');
      return c;
    },
    async 'chat.new'() { return { chat: chats.create() }; },
    async 'chat.delete'({ chat }) { return chats.remove(chat); },
    async prompt({ chat, text, mode, context, attachments }) {
      const atts = (Array.isArray(attachments) ? attachments : []).map(id => uploads.get(id) && uploads.get(id).info).filter(Boolean);
      return chats.send({ chat, text, mode, context, attachments: atts });
    },
    async 'prompt.stop'({ chat }) { return chats.stop(chat); },
    async 'agent.answer'({ rid, allowed }) { return chats.answer(String(rid || ''), allowed === true); },
    async 'agent.settings'(changes) { return changes && Object.keys(changes).some(k => k !== 'id' && k !== 'type') ? chats.setSettings(changes) : chats.settings(); },
    async 'chat.screenshot'({ chat }) { return chats.screenshot(chat); },
    // A picture of the main display (Siri / Shortcuts: "Show my Mac's screen")
    async 'screen.snapshot'() {
      const list = await mac.call('displays');
      const d = list.find(x => x.main) || list[0];
      return screenshot({ x: d.x, y: d.y, w: d.w, h: d.h }, 1600);
    },

    // Screen: video goes out as binary messages; the phone acks each frame (see screen.js)
    async 'screen.start'(_, client) { if (!screen) throw new Error('Screen sharing needs a Mac.'); return screen.join(client); },
    async 'screen.stop'(_, client) { if (screen) screen.leave(client); return true; },
    async 'screen.ack'({ seq }, client) { if (screen) screen.ack(client, seq); },
    async 'screen.input'(msg) { if (screen) screen.input(msg); },
    async 'screen.config'(msg, client) { if (!screen) throw new Error('Screen sharing needs a Mac.'); return screen.configure(msg, client); },
  };

  // Events from VS Code
  host.onEvent(ev => {
    if (ev.type === 'doc') {
      let text;
      for (const c of clients) {
        if (!c.authed || c.watching !== ev.path || c.id === ev.origin) continue;
        if (text === undefined) text = ev.text();
        c.send({ type: 'doc', path: ev.path, text, dirty: ev.dirty });
      }
    } else if (ev.type === 'disk') {
      // A file changed on disk (e.g. Claude edited it). Only matters if it's not open in VS Code.
      broadcast({ type: 'files.changed' });
      for (const c of clients) {
        if (!c.authed || c.watching !== ev.path) continue;
        Promise.resolve(host.readDoc(ev.path)).then(open => open ? null : fsp.readFile(ev.path, 'utf8'))
          .then(text => { if (text != null) c.send({ type: 'doc', path: ev.path, text, dirty: false }); }).catch(() => {});
      }
    } else {
      broadcast(ev);
    }
  });

  // HTTP: the phone client (static, no secrets) + WebSocket API
  const onRequest = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.join(WEB_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(WEB_DIR)) { res.writeHead(403); return res.end(); }
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
  };
  const server = http.createServer(onRequest);
  const extraServers = [];

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  wss.on('error', () => {});
  const onUpgrade = (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      attach(ws, ip);
    });
  };
  server.on('upgrade', onUpgrade);

  // A connection from the phone. `conn` is a WebSocket or anything shaped like one (send, close, readyState,
  // on('message'|'close')), e.g. an end-to-end encrypted relay channel. `authed` skips the access code,
  // for channels that are already authenticated by the pairing key.
  function attach(conn, ip, { authed = false } = {}) {
    const ws = conn;
    const client = { id: nextClient++, ws, authed: false, watching: null };
    client.send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
    client.sendBinary = (b) => { if (ws.readyState === 1) (ws.sendBinary ? ws.sendBinary(b) : ws.send(b)); };
    clients.add(client);
    const authTimer = authed ? null : setTimeout(() => { if (!client.authed) ws.close(4001, 'auth timeout'); }, 10000);
    if (authed) { client.authed = true; client.send({ type: 'ready', ...hello() }); }

    ws.on('message', async raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!client.authed) {
        const f = failures.get(ip);
        if (f && f.count >= 8 && Date.now() - f.since < 15 * 60 * 1000) return ws.close(4003, 'locked out');
        if (msg.type === 'auth' && token && tokensMatch(msg.token || '', token)) {
          client.authed = true;
          failures.delete(ip);
          clearTimeout(authTimer);
          return client.send({ type: 'ready', ...hello() });
        }
        const e = failures.get(ip) || { count: 0, since: Date.now() };
        e.count++;
        failures.set(ip, e);
        return ws.close(4001, 'bad code');
      }
      const { id, type } = msg;
      const fn = handlers[type];
      try {
        if (!fn) throw new Error(`Unknown request: ${type}`);
        const result = await fn(msg, client);
        if (id != null) client.send({ id, ok: true, result });
      } catch (e) {
        if (id != null) client.send({ id, ok: false, error: e.message || String(e) });
      }
    });
    ws.on('close', () => { clients.delete(client); clearTimeout(authTimer); if (screen) screen.leave(client); });
    return client;
  }

  function listenOn(srv, port, hostname, tries) {
    return new Promise((resolve, reject) => {
      const attempt = (p, left) => {
        const onErr = (e) => {
          srv.removeListener('listening', onOk);
          if (e.code === 'EADDRINUSE' && left > 1) attempt(p + 1, left - 1);
          else reject(e);
        };
        const onOk = () => { srv.removeListener('error', onErr); resolve(srv.address().port); };
        srv.once('error', onErr);
        srv.once('listening', onOk);
        srv.listen(p, hostname);
      };
      attempt(port, tries);
    });
  }
  const listen = (port, hostname = '127.0.0.1', tries = 10) => listenOn(server, port, hostname, tries);
  // Also serve on another address, e.g. this computer's Wi-Fi address for "same Wi-Fi" phones.
  async function listenAlso(port, hostname) {
    const srv = http.createServer(onRequest);
    srv.on('upgrade', onUpgrade);
    const p = await listenOn(srv, port, hostname, 1);
    extraServers.push(srv);
    return p;
  }
  function close() {
    chats.close(); mcp.close(); mac.close();
    for (const r of runs.values()) if (r.proc) { try { process.kill(-r.proc.pid, 'SIGKILL'); } catch {} }
    for (const c of clients) { try { c.ws.terminate ? c.ws.terminate() : c.ws.close(1001, 'closing'); } catch {} }
    wss.close();
    for (const srv of extraServers) srv.close();
    return new Promise(r => server.close(() => r()));
  }

  return { listen, listenAlso, attach, close, server, chats };
}

function findClaude(extensionsDir) {
  try {
    const dirs = fs.readdirSync(extensionsDir).filter(d => d.startsWith('anthropic.claude-code-'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const d of dirs.reverse()) {
      const bin = path.join(extensionsDir, d, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
      if (fs.existsSync(bin)) return bin;
    }
  } catch {}
  for (const p of ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(os.homedir(), '.claude/local/claude')]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

module.exports = { createPortalServer, findClaude, SAFE_TOOLS };
