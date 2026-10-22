'use strict';
// Chats: every chat is a saved Claude Code session, run headless with stream-json in and out.
//
// Each message picks what Claude can do:
//   mac   - controls the Mac with Portal's tools (agent/tools.js over MCP): apps, windows, clicks, typing, shell...
//   edits / full / plan - works in the project like Claude Code in VS Code (Auto-edit, Full access, Plan only)
// Several chats can run at once (they take turns with the mouse and keyboard). Sending to a running chat adds to
// the task without stopping it. Chats are kept in ~/.vscode-portal/chats, shared by every VS Code window, and are
// searchable; the Mac agent also keeps notes (memory) in ~/.vscode-portal/notes.md.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createTools, SYSTEM } = require('./agent/tools');
const { NAME: MCP_NAME } = require('./agent/mcp');

const DIR = path.join(os.homedir(), '.vscode-portal');
const CHAT_DIR = path.join(DIR, 'chats');
const NOTES = path.join(DIR, 'notes.md');
const SETTINGS_FILE = path.join(DIR, 'agent-settings.json');
const WORK_DIR = path.join(DIR, 'agent-work'); // where Mac chats run (Claude Code keeps sessions per folder)
const MAX_EVENTS = 1500;
const MAX_SAVED_IMAGES = 12;     // older screenshots in a chat are dropped from the saved copy
const MAX_NOTES_CHARS = 16000;
const MAC_MODEL = 'claude-sonnet-5-5';
const STOP_GRACE_MS = 3000;
// Commands Claude may run without asking in Auto-edit mode
const SAFE_TOOLS = [
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git add:*)',
  'Bash(git commit:*)', 'Bash(git push)', 'Bash(git branch:*)', 'Bash(ls:*)', 'Bash(npm test:*)',
  'Bash(npm run lint:*)', 'Bash(npm run build:*)', 'Bash(npm run typecheck:*)', 'Bash(npx tsc:*)',
];
const MODES = ['mac', 'edits', 'full', 'plan'];
// Environment Claude Code must not see: an API key bills the API instead of the plan, and variables from a Claude
// Code session (when VS Code was started from one) would make it act as a child of that session
const DROP_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT'];
const DROP_PREFIX = ['CLAUDE_CODE_', 'CLAUDE_AGENT_SDK'];

const newId = () => `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
const VALID_ID = /^\d{14}-[0-9a-f]{6}$/;
const words = (s) => String(s).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];

// ---------- the store ----------

function createStore() {
  fs.mkdirSync(CHAT_DIR, { recursive: true, mode: 0o700 });
  const cache = new Map();
  const file = (id) => path.join(CHAT_DIR, `${id}.json`);
  function get(id) {
    if (!VALID_ID.test(String(id))) return null;
    if (cache.has(id)) return cache.get(id);
    try { const c = JSON.parse(fs.readFileSync(file(id), 'utf8')); cache.set(id, c); return c; } catch { return null; }
  }
  const saveTimers = new Map();
  function save(chat, now = false) {
    clearTimeout(saveTimers.get(chat.id));
    const write = () => {
      saveTimers.delete(chat.id);
      // Keep only the latest screenshots in the saved copy; chats stay small
      let images = 0;
      const events = chat.events.slice(-MAX_EVENTS).reverse().map((e) => (e.image && ++images > MAX_SAVED_IMAGES ? { ...e, image: null } : e)).reverse();
      fs.writeFile(file(chat.id), JSON.stringify({ ...chat, events }), { mode: 0o600 }, () => {});
    };
    if (now) write(); else saveTimers.set(chat.id, setTimeout(write, 500));
  }
  function create({ cwd } = {}) {
    const chat = { id: newId(), title: 'New chat', created: Date.now(), updated: Date.now(), session: null, cwd: cwd || WORK_DIR, events: [] };
    cache.set(chat.id, chat);
    save(chat, true);
    return chat;
  }
  function list() {
    let names = [];
    try { names = fs.readdirSync(CHAT_DIR).filter((n) => n.endsWith('.json')); } catch {}
    return names.map((n) => get(n.slice(0, -5))).filter(Boolean)
      .map((c) => ({ id: c.id, title: c.title, updated: c.updated, preview: lastText(c) }))
      .sort((a, b) => b.updated - a.updated);
  }
  function lastText(c) {
    for (let i = c.events.length - 1; i >= 0; i--) {
      const e = c.events[i];
      if (e.type === 'portal.user') return `You: ${e.text}`;
      if (e.type === 'assistant') {
        const t = ((e.message && e.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
        if (t) return t;
      }
    }
    return '';
  }
  function remove(id) { cache.delete(id); try { fs.unlinkSync(file(id)); return true; } catch { return false; } }

  // Each message as text, for search and for continuing a chat whose session is gone
  function texts(c) {
    const out = [];
    for (const e of c.events) {
      if (e.type === 'portal.user' && e.text) out.push({ who: 'User', text: e.text, at: e.at || c.updated });
      else if (e.type === 'assistant') {
        const t = ((e.message && e.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (t) out.push({ who: 'You', text: t, at: c.updated });
      }
    }
    return out;
  }
  // BM25 over every message in every chat (chat titles count too)
  function search(query, { exclude, limit = 8 } = {}) {
    const terms = [...new Set(words(query))];
    if (!terms.length) return [];
    const docs = [];
    for (const { id } of list()) {
      if (id === exclude) continue;
      const c = get(id);
      const tw = words(c.title);
      for (const m of texts(c)) {
        const counts = new Map();
        for (const w of [...words(m.text), ...tw]) counts.set(w, (counts.get(w) || 0) + 1);
        docs.push({ c, m, counts, len: [...counts.values()].reduce((a, b) => a + b, 0) || 1 });
      }
    }
    if (!docs.length) return [];
    const avg = docs.reduce((a, d) => a + d.len, 0) / docs.length;
    const df = new Map();
    for (const d of docs) for (const t of terms) if (d.counts.has(t)) df.set(t, (df.get(t) || 0) + 1);
    const scored = [];
    for (const d of docs) {
      let s = 0;
      for (const t of terms) {
        const f = d.counts.get(t); if (!f) continue;
        const idf = Math.log(1 + (docs.length - df.get(t) + 0.5) / (df.get(t) + 0.5));
        s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.len / avg));
      }
      if (s > 0) scored.push({ s, d });
    }
    scored.sort((a, b) => b.s - a.s);
    const perChat = new Map(), out = [];
    for (const { d } of scored) {
      const n = perChat.get(d.c.id) || 0;
      if (n >= 3) continue;
      perChat.set(d.c.id, n + 1);
      out.push({ chat: d.c.id, title: d.c.title, who: d.m.who, text: d.m.text.slice(0, 400), at: d.m.at });
      if (out.length >= limit) break;
    }
    return out;
  }

  const notes = () => {
    // Own notes + the Portal agent's shared memory (~/.config/portal/memory.md), so every AI here knows the same IDs, repos and preferences.
    let own = ''; try { own = fs.readFileSync(NOTES, 'utf8'); } catch {}
    let shared = ''; try { shared = fs.readFileSync(path.join(os.homedir(), '.config', 'portal', 'memory.md'), 'utf8'); } catch {}
    const have = new Set(shared.split('\n').map((l) => l.trim()));
    const extra = own.split('\n').filter((l) => l.trim() && !have.has(l.trim())).join('\n');
    return (shared.trim() + (extra ? '\n' + extra : '')).slice(0, MAX_NOTES_CHARS);
  };
  function remember(fact) {
    const line = String(fact).replace(/\s+/g, ' ').trim().slice(0, 300);
    if (line) fs.appendFileSync(NOTES, `- ${line}\n`, { mode: 0o600 });
  }
  // Brings over the old Portal's chats (~/.config/portal/chats) and notes; safe to run again (skips what's here)
  function importPortal(dir = path.join(os.homedir(), '.config', 'portal')) {
    let chats = 0, notesAdded = 0;
    let files = [];
    try { files = fs.readdirSync(path.join(dir, 'chats')).filter((n) => n.endsWith('.json')); } catch {}
    for (const name of files) {
      let old; try { old = JSON.parse(fs.readFileSync(path.join(dir, 'chats', name), 'utf8')); } catch { continue; }
      const id = String(old.id || '').replace(/^(\d{8})-(\d{6})-/, '$1$2-');
      if (!VALID_ID.test(id) || get(id)) continue;
      const events = [];
      for (const e of old.events || []) {
        const at = Math.round((e.t || 0) * 1000);
        if (e.kind === 'user') events.push({ type: 'portal.user', text: e.text || '', mode: 'mac', addendum: !!e.addendum, at,
          attachments: [...(e.images || []).map((_, i) => ({ name: `photo ${i + 1}`, kind: 'image' })), ...(e.files || []).map((f) => ({ name: f.name, kind: 'file' }))] });
        else if (e.kind === 'reply') events.push({ type: 'assistant', message: { content: [{ type: 'text', text: e.text || '' }] } });
        else if (e.kind === 'step' || e.kind === 'note') events.push({ type: 'portal.note', text: e.text || '' });
        else if (e.kind === 'notice') events.push({ type: 'portal.notice', text: e.text || '' });
        else if (e.kind === 'image') events.push({ type: 'portal.image', image: e.image || null, caption: e.caption || '', at });
        else if (e.kind === 'approve') events.push({ type: 'portal.approve', rid: e.rid, command: e.command || '', reason: e.reason || '', at });
        else if (e.kind === 'approved') events.push({ type: 'portal.approved', rid: e.rid, allowed: !!e.allowed, at });
      }
      const chat = { id, title: old.title || 'Chat from Portal', created: Math.round((old.created || 0) * 1000) || Date.now(),
        updated: Math.round((old.updated || 0) * 1000) || Date.now(), session: null, cwd: WORK_DIR, events, imported: 'portal' };
      cache.set(id, chat); save(chat, true); chats++;
    }
    try {
      const have = notes();
      for (const line of fs.readFileSync(path.join(dir, 'memory.md'), 'utf8').split('\n')) {
        const fact = line.replace(/^\s*[-*]\s*/, '').trim();
        if (fact && !have.includes(fact)) { remember(fact); notesAdded++; }
      }
    } catch {}
    return { chats, notes: notesAdded };
  }
  return { get, save, create, list, remove, search, texts, notes, remember, importPortal };
}

// ---------- running chats ----------

// Free-AI fallback: when the Claude plan hits its limit, Claude Code is pointed at a small local proxy
// (free-ai-proxy.js) that answers from free providers (Gemini, Groq, OpenRouter, ...), rotating as free quotas run
// out. It stays on the free models for 30 minutes, then tries the Claude plan again.
const FREE_PORT = 8787;
const FREE_FOR_MS = 30 * 60 * 1000;
const LIMIT_RE = /usage limit|limit reached|rate.?limit|overloaded|credit balance|quota|\b429\b|\b529\b|out of extra usage|too many requests/i;
let freeUntil = 0;      // claude-first mode: on free models until this time after a Claude limit
let claudeUntil = 0;    // free-then-claude mode: on the Claude plan until this time after every free slot failed
let AI_MODE = 'free';   // 'free' (default: free models only, never spends), 'free-then-claude', 'claude-first'
const freeMode = () => (AI_MODE === 'claude-first' ? Date.now() < freeUntil : Date.now() >= claudeUntil);
async function ensureFreeProxy() {
  const up = async () => { try { return (await fetch(`http://127.0.0.1:${FREE_PORT}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
  if (await up()) return true;
  try {
    const child = spawn(process.env.PORTAL_NODE || 'node', [path.join(__dirname, 'free-ai-proxy.js')], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch { return false; }
  for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 250)); if (await up()) return true; }
  return false;
}

function createChats({ claudeBin, macBinary, mac, mcp, roots, uploadDir, useApiKey = false, aiMode = 'free', broadcast, log = () => {} }) {
  AI_MODE = ['free', 'free-then-claude', 'claude-first'].includes(aiMode) ? aiMode : 'free';
  const store = createStore();
  const runs = new Map();      // chat id -> run
  const approvals = new Map(); // request id -> { resolve, chat }
  let settings = { autoApproveShell: true, showActions: true };
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch {}

  const status = (id) => ({ type: 'chat.status', chat: id, running: runs.has(id), title: (store.get(id) || {}).title });
  // Adds an event to a chat: saved (unless live-only) and sent to every phone
  function record(chat, event, { save = true } = {}) {
    if (save) { chat.events.push(event); chat.updated = Date.now(); store.save(chat); }
    broadcast({ type: 'chat.event', chat: chat.id, event });
  }

  function env() {
    const e = {};
    for (const [k, v] of Object.entries(process.env)) {
      if ((!useApiKey || !k.startsWith('ANTHROPIC')) && DROP_ENV.includes(k)) continue;
      if (DROP_PREFIX.some((p) => k.startsWith(p))) continue;
      e[k] = v;
    }
    e.MCP_TOOL_TIMEOUT = String(3600 * 1000); // approvals and long commands can take a while
    e.ENABLE_TOOL_SEARCH = 'false';
    if (freeMode()) {
      delete e.ANTHROPIC_API_KEY; // never the paid API key while on the free models
      e.ANTHROPIC_BASE_URL = `http://127.0.0.1:${FREE_PORT}`;
      e.ANTHROPIC_AUTH_TOKEN = 'free';
      e.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    }
    return e;
  }

  function args(chat, mode, mcpUrl) {
    const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    const notes = store.notes().trim();
    if (mode === 'mac') {
      let system = SYSTEM + (notes ? `\n\nYour notes (facts you saved in earlier chats):\n${notes}` : '');
      if (chat.monitors > 1) system += `\n- The user has ${chat.monitors} monitors. Screenshots show the monitor with the front window; use look_at to see another monitor or all of them. Coordinates always refer to the latest screenshot.`;
      a.push('--model', MAC_MODEL, '--effort', 'medium', '--system-prompt', system, '--tools', '',
        '--mcp-config', JSON.stringify({ mcpServers: { [MCP_NAME]: { type: 'http', url: mcpUrl } } }), '--strict-mcp-config',
        '--setting-sources', '', '--disable-slash-commands', '--permission-mode', 'dontAsk', '--allowedTools', `mcp__${MCP_NAME}`);
    } else {
      if (mode === 'full') a.push('--permission-mode', 'bypassPermissions');
      else if (mode === 'plan') a.push('--permission-mode', 'plan');
      else a.push('--permission-mode', 'acceptEdits', '--allowedTools', SAFE_TOOLS.join(','));
      if (notes) a.push('--append-system-prompt', `Notes the user's assistant saved in earlier chats:\n${notes}`);
    }
    a.push(...(chat.session ? ['--resume', chat.session] : ['--session-id', (chat.session = crypto.randomUUID())]));
    return a;
  }

  const userLine = (content) => JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });

  async function start(chat, mode, content, retried = false, addDir = null) {
    const ctrl = new AbortController();
    const run = { mode, proc: null, ctrl, stdinOpen: true, addenda: [], started: Date.now(), stopping: false, mcp: null };
    runs.set(chat.id, run);
    broadcast(status(chat.id));

    let mcpUrl = null;
    if (mode === 'mac') {
      try { chat.monitors = (await mac.call('displays')).length; } catch {}
      const tools = createTools({
        mac, settings, signal: ctrl.signal,
        memory: { notes: store.notes, remember: store.remember, search: (q) => {
          const hits = store.search(q, { exclude: chat.id });
          return hits.length ? hits.map((h) => `[${new Date(h.at).toDateString().slice(4, 10)} · "${h.title}"] ${h.who}: ${h.text}`).join('\n') : `No past chats mention "${q}".`;
        } },
        ui: {
          step: () => {},
          image: (data, caption, live) => record(chat, { type: 'portal.image', image: data, caption, live: !!live, at: Date.now() }, { save: !live }),
          approve: (command, reason) => new Promise((resolve) => {
            const rid = crypto.randomBytes(6).toString('hex');
            approvals.set(rid, { resolve, chat: chat.id });
            record(chat, { type: 'portal.approve', rid, command, reason, at: Date.now() });
            ctrl.signal.addEventListener('abort', () => { if (approvals.delete(rid)) resolve(false); }, { once: true });
          }),
        },
      });
      run.mcp = await mcp.register({ list: tools.list, call: tools.call });
      mcpUrl = run.mcp.url;
    }

    if (freeMode()) await ensureFreeProxy();
    const cwd = mode === 'mac' && !fs.existsSync(chat.cwd) ? WORK_DIR : chat.cwd;
    await fsp.mkdir(WORK_DIR, { recursive: true });
    const a = args(chat, mode, mcpUrl);
    if (addDir && mode !== 'mac') a.push('--add-dir', addDir);
    const proc = spawn(claudeBin, a, { cwd, env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
    run.proc = proc;
    store.save(chat, true); // keeps the session id
    proc.stdin.on('error', () => {});
    proc.stdin.write(userLine(content) + '\n');

    let buf = '', errText = '', failed = null, sawResult = false, limitNote = null;
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'stream_event') { record(chat, ev, { save: false }); continue; }
        if (ev.type === 'rate_limit_event' && ev.rate_limit_info && ev.rate_limit_info.status === 'rejected') {
          const r = ev.rate_limit_info.resetsAt;
          // Only an explanation if the task fails: a request can still go through after this notice
          limitNote = `Claude plan usage limit reached${r ? ` (resets ${new Date(r * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : ''}.`;
          continue;
        }
        if (ev.type === 'system' && ev.subtype !== 'init') continue;
        if (ev.type === 'result') {
          sawResult = true;
          if (ev.is_error && !failed) failed = limitNote || String(ev.result || (ev.errors || []).join('; ') || ev.subtype);
          // Added to while it finished: keep going with that; otherwise close stdin so it exits
          if (run.addenda.length) { flushAddenda(run); record(chat, ev); continue; }
          run.stdinOpen = false;
          try { proc.stdin.end(); } catch {}
        }
        record(chat, ev);
      }
    });
    proc.stderr.on('data', (d) => { errText = (errText + d).slice(-4000); });
    proc.on('error', (e) => record(chat, { type: 'portal.error', text: `Couldn't start Claude Code: ${e.message}` }));
    proc.on('close', (code) => {
      if (run.mcp) run.mcp.close();
      for (const [rid, a] of approvals) if (a.chat === chat.id) { approvals.delete(rid); a.resolve(false); }
      runs.delete(chat.id);
      const gone = /no conversation found/i.test(errText + (failed || ''));
      if (gone && !retried && !run.stopping) {
        // The session file is gone (e.g. Claude Code was reinstalled): start fresh with the chat so far
        chat.session = null;
        const earlier = store.texts(chat).slice(-30).map((m) => `${m.who}: ${m.text}`).join('\n').slice(-12000);
        const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        start(chat, mode, [{ type: 'text', text: `(This chat continues an earlier conversation; here's what was said:\n${earlier}\n)\n\n${text}` }], true);
        return;
      }
      const limited = !run.stopping && LIMIT_RE.test((failed || '') + (limitNote || '') + errText);
      if (limited && AI_MODE === 'claude-first' && !freeMode()) {
        ensureFreeProxy().then((ok) => {
          if (!ok) { record(chat, { type: 'portal.error', text: failed || limitNote || 'Claude plan limit reached.' }); broadcast(status(chat.id)); return; }
          freeUntil = Date.now() + FREE_FOR_MS;
          record(chat, { type: 'portal.notice', text: "Claude's limit was reached, so I'm continuing on free AI models (rotating between Gemini, Groq, OpenRouter and the Mac's own model). Claude comes back automatically later." });
          start(chat, mode, content, true, addDir);
        });
        return;
      }
      if (limited && AI_MODE === 'free-then-claude' && freeMode()) {
        // Every free slot (and the Mac's own model) failed: use the Claude plan for a while
        claudeUntil = Date.now() + FREE_FOR_MS;
        record(chat, { type: 'portal.notice', text: 'The free AI models are all busy or used up right now, so I\'m using your Claude plan for a while.' });
        start(chat, mode, content, true, addDir);
        return;
      }
      if (limited && AI_MODE === 'free' && freeMode()) {
        record(chat, { type: 'portal.error', text: 'All the free AI models are busy or used up right now (this mode never spends money). Try again in a few minutes, or switch vscodePortal.aiMode to free-then-claude.' });
        broadcast(status(chat.id));
        return;
      }
      if (run.stopping) record(chat, { type: 'portal.stopped', at: Date.now() });
      else if (failed) record(chat, { type: 'portal.error', text: failed });
      else if (code && !sawResult) record(chat, { type: 'portal.error', text: limitNote || errText.trim().split('\n').slice(-3).join('\n') || `Claude Code exited with code ${code}` });
      broadcast(status(chat.id));
      log(`chat ${chat.id} finished (${code})`);
    });
  }

  function flushAddenda(run) {
    const texts = run.addenda.splice(0);
    for (const t of texts) {
      try { run.proc.stdin.write(userLine([{ type: 'text', text: `(The user added this while you were working; take it into account and keep going with the task: ${t})` }]) + '\n'); } catch {}
    }
  }

  // What to send Claude: the text, what the phone is looking at, and attachments. In the project modes Claude
  // reads attachments with its Read tool; the Mac mode has no file tools, so pictures and PDFs go in the message.
  function buildContent(mode, text, context, atts) {
    let full = text;
    if (context && context.path) {
      full += `\n\n(Context from VSCode Portal, the user is on their phone: they're looking at ${context.path}`
        + (context.line ? ` around line ${context.line}` : '')
        + (context.selection ? `, with this selected:\n\`\`\`\n${String(context.selection).slice(0, 4000)}\n\`\`\`` : '') + '.)';
    }
    const blocks = [];
    if (atts.length && mode !== 'mac') {
      full += '\n\n(Attachments from VSCode Portal. Use the Read tool to view these files:';
      for (const a of atts) {
        if (a.kind === 'video') {
          full += `\n- Video "${a.name}" (${a.duration ? a.duration.toFixed(1) + 's' : 'unknown length'}), ${a.frames.length} frames sampled evenly in time order, read all of them to follow what happens: `
            + a.frames.map((f) => `${f.path} (t=${f.t}s)`).join(', ') + `. Original file: ${a.path}. ${a.note || ''}`;
        } else full += `\n- ${a.kind} "${a.name}": ${a.path}`;
      }
      full += ')';
    } else if (atts.length) {
      const image = (file) => ({ type: 'image', source: { type: 'base64', media_type: /\.png$/i.test(file) ? 'image/png' : 'image/jpeg', data: fs.readFileSync(file).toString('base64') } });
      const notes = [];
      for (const a of atts) {
        try {
          if (a.kind === 'image') blocks.push(image(a.path));
          else if (a.kind === 'video') {
            for (const f of a.frames) blocks.push(image(f.path));
            notes.push(`(Video ${a.name}: the ${a.frames.length} pictures above are evenly spaced frames from it. The full video is at ${a.path}. ${a.note || ''})`);
          } else if (/\.pdf$/i.test(a.path)) {
            blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(a.path).toString('base64') } });
          } else notes.push(`(The user attached ${a.name}; it's saved at ${a.path}.)`);
        } catch { notes.push(`(Couldn't read the attachment ${a.name}.)`); }
      }
      if (notes.length) full += '\n\n' + notes.join('\n');
    }
    return [...blocks, { type: 'text', text: full }];
  }

  return {
    settings: () => ({ ...settings }),
    setSettings(changes) {
      for (const k of ['autoApproveShell', 'showActions']) if (typeof changes[k] === 'boolean') settings[k] = changes[k];
      fs.writeFile(SETTINGS_FILE, JSON.stringify(settings), { mode: 0o600 }, () => {});
      broadcast({ type: 'agent.settings', settings: { ...settings } });
      return { ...settings };
    },
    list(query) {
      const q = String(query || '').trim();
      const all = store.list().map((c) => ({ ...c, running: runs.has(c.id) }));
      if (!q) return all.slice(0, 200);
      const hits = new Set(store.search(q, { limit: 60 }).map((h) => h.chat));
      const lower = q.toLowerCase();
      return all.filter((c) => hits.has(c.id) || c.title.toLowerCase().includes(lower));
    },
    open(id, { limit = 120 } = {}) {
      const chat = store.get(id);
      if (!chat) return null;
      const events = chat.events.slice(-limit);
      return { id: chat.id, title: chat.title, running: runs.has(id), events, hidden: chat.events.length - events.length };
    },
    create() { return store.create({ cwd: (roots()[0] || WORK_DIR) }).id; },
    remove(id) {
      if (runs.has(id)) throw new Error('Stop that task before deleting its chat.');
      if (!store.remove(id)) throw new Error('That chat doesn\'t exist anymore.');
      broadcast({ type: 'chat.deleted', chat: id });
      return true;
    },
    // A message: starts a task, or joins the running one without stopping it
    async send({ chat: id, text, mode, context, attachments }) {
      text = String(text || '').trim();
      if (!text && !(attachments || []).length) throw new Error('Empty message');
      if (!claudeBin) throw new Error('Claude Code not found. Install the Claude Code extension or set vscodePortal.claudePath.');
      mode = MODES.includes(mode) ? mode : 'edits';
      if (mode === 'mac' && (process.platform !== 'darwin' || !fs.existsSync(macBinary))) throw new Error('The Mac mode needs a Mac.');
      let chat = store.get(id);
      if (!chat) chat = store.create({ cwd: mode === 'mac' ? WORK_DIR : (roots()[0] || WORK_DIR) });
      const run = runs.get(chat.id);
      if (run) {
        record(chat, { type: 'portal.user', text, mode: run.mode, addendum: true, at: Date.now() });
        run.addenda.push(text);
        if (run.stdinOpen) flushAddenda(run);
        return { chat: chat.id, added: true };
      }
      if (chat.title === 'New chat') chat.title = text.replace(/\s+/g, ' ').slice(0, 60) || 'New chat';
      record(chat, { type: 'portal.user', text, mode, context: (context && context.path) || null,
        attachments: (attachments || []).map((a) => ({ name: a.name, kind: a.kind, frames: (a.frames || []).length })), at: Date.now() });
      await start(chat, mode, buildContent(mode, text, context, attachments || []), false, (attachments || []).length ? uploadDir : null);
      return { chat: chat.id, started: true };
    },
    stop(id) {
      const run = runs.get(id);
      if (!run) return false;
      run.stopping = true;
      run.ctrl.abort();
      try { run.proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'interrupt' } }) + '\n'); } catch {}
      const p = run.proc;
      setTimeout(() => { if (runs.get(id) === run) { try { p.kill('SIGINT'); } catch {} } }, STOP_GRACE_MS).unref?.();
      setTimeout(() => { if (runs.get(id) === run) { try { p.kill('SIGKILL'); } catch {} } }, STOP_GRACE_MS * 2).unref?.();
      return true;
    },
    answer(rid, allowed) {
      const a = approvals.get(rid);
      if (!a) return false;
      approvals.delete(rid);
      a.resolve(!!allowed);
      const chat = store.get(a.chat);
      if (chat) record(chat, { type: 'portal.approved', rid, allowed: !!allowed, at: Date.now() });
      return true;
    },
    // A screenshot of the Mac, on demand, into the chat
    async screenshot(id) {
      const chat = store.get(id) || store.create({ cwd: WORK_DIR });
      const tools = createTools({ mac, settings, memory: {}, ui: { step() {}, image: (data, caption) => record(chat, { type: 'portal.image', image: data, caption, at: Date.now() }), approve: async () => false } });
      await tools.call('send_screenshot', { caption: 'Your screen right now' });
      return { chat: chat.id };
    },
    running: () => [...runs.keys()],
    importPortal: () => store.importPortal(),
    close() { for (const id of runs.keys()) this.stop(id); },
  };
}

module.exports = { createChats, createStore };
