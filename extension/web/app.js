'use strict';
// VSCode Portal phone client.
const $ = (s) => document.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
}
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const base = (p) => String(p).split('/').pop();
function toast(text, ms = 2200) {
  const t = $('#toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- state ----------
const S = {
  hello: null, view: 'files', file: null, pendingWrite: null, follow: false,
  chatRunning: false, termTarget: 'here', runId: null, ctxOn: true,
};
const rel = (p) => {
  if (!S.hello) return p;
  for (const f of S.hello.folders) if (p === f.path || p.startsWith(f.path + '/')) {
    const r = p.slice(f.path.length + 1);
    return S.hello.folders.length > 1 ? `${f.name}/${r}` : (r || f.name);
  }
  return p.replace(S.hello.home, '~');
};

// ---------- connection ----------
// Two ways in: a direct link with an access code (#token=..., over Tailscale or the same Wi-Fi), or a
// pairing link (#pair=KEY.ROOM) opened on a relay, which reaches the computer from anywhere with
// end-to-end encryption. The pairing key never leaves the phone and the computer.
const hashQ = new URLSearchParams(location.hash.slice(1));
if (hashQ.get('token')) localStorage.setItem('vsp.token', hashQ.get('token'));
if (hashQ.get('pair')) { localStorage.setItem('vsp.pair', hashQ.get('pair')); localStorage.removeItem('vsp.host'); }
if (location.hash) history.replaceState(null, '', location.pathname);
let token = localStorage.getItem('vsp.token') || '';
const pairing = (() => {
  const p = localStorage.getItem('vsp.pair');
  if (!p || !window.E2E || !window.crypto.subtle) return null;
  const [key, room] = p.split('.');
  return key && room ? { key, room } : null;
})();
let ws = null, nextId = 1, connected = false, backoff = 500, relayKeys = null;
const pending = new Map();

function setConn(state, text) {
  $('#dot').className = state;
  if (text) $('#sub').textContent = text;
}
function onWire(text) {
  const m = JSON.parse(text);
  if (m.id != null && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    return m.ok ? p.res(m.result) : p.rej(new Error(m.error));
  }
  onEvent(m);
}
function onDrop(e) {
  connected = false;
  if (S.switching) {
    // Picked another window: reconnect at once, starting fresh
    S.switching = false;
    for (const p of pending.values()) p.rej(new Error('Disconnected'));
    pending.clear();
    S.file = null;
    editor.setDoc('', ''); $('#ed-path').textContent = 'No file open';
    setConn('', 'Switching…');
    return connect();
  }
  for (const p of pending.values()) p.rej(new Error('Disconnected'));
  pending.clear();
  if (!pairing && (e.code === 4001 || e.code === 4003)) {
    localStorage.removeItem('vsp.token'); token = '';
    return showLogin(e.code === 4003 ? 'Too many wrong codes. Try again later.' : 'That code is not right.');
  }
  if (pairing && e.code === 4003) return showLogin('This pairing is no longer valid. Scan the QR code in VS Code again.');
  setConn('off', pairing && e.code === 4404 ? 'Computer is offline. Retrying…' : 'Reconnecting…');
  setTimeout(connect, backoff); backoff = Math.min(backoff * 2, pairing ? 15000 : 8000);
}
function connect() {
  if (pairing) return connectRelay();
  if (!token) return showLogin();
  setConn('', 'Connecting…');
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (e) => (typeof e.data === 'string' ? onWire(e.data) : Screen.onPacket(new Uint8Array(e.data)));
  ws.onclose = onDrop;
}
// Every VS Code window on the paired computers that's online right now, with its decrypted name
async function listHosts() {
  const q = new URLSearchParams({ room: pairing.room, proof: relayKeys.clientProof });
  const res = await fetch('/hosts?' + q);
  if (res.status === 404) throw Object.assign(new Error('unknown pairing'), { code: 4003 });
  const hosts = [];
  for (const h of await res.json()) { try { hosts.push({ id: h.id, since: h.since, ...(await E2E.openLabel(relayKeys.label, h.label)) }); } catch {} }
  return hosts.sort((a, b) => (a.computer || '').localeCompare(b.computer || '') || (a.name || '').localeCompare(b.name || ''));
}
async function pickHost() {
  const hosts = await listHosts();
  if (!hosts.length) throw Object.assign(new Error('offline'), { code: 4404 });
  const saved = localStorage.getItem('vsp.host');
  if (hosts.some(h => h.id === saved)) return saved;
  if (hosts.length === 1) return hosts[0].id;
  return new Promise(resolve => showWindows(hosts, null, (id) => { localStorage.setItem('vsp.host', id); resolve(id); }, false));
}
// The window list: shown at the start when there's more than one, and from the header any time
function showWindows(hosts, current, choose, closable = true) {
  document.querySelector('#hostpick')?.remove();
  const box = h('div', { id: 'hostpick' });
  const list = h('div', { class: 'hp-list' });
  for (const w of hosts) {
    list.append(h('button', { class: `hp-item${w.id === current ? ' current' : ''}`, onclick: () => { box.remove(); if (w.id !== current) choose(w.id); } },
      h('b', {}, w.name || 'VS Code'), h('span', {}, `${w.computer || ''}${w.id === current ? ' · connected' : ''}`)));
  }
  if (!hosts.length) list.append(h('p', { class: 'note' }, 'No VS Code windows are online. Open VS Code on your computer.'));
  box.append(h('div', { class: 'login-card' }, h('h2', {}, 'VS Code windows'),
    h('p', { class: 'hp-note' }, 'Every window with VSCode Portal running shows up here.'), list,
    closable ? h('button', { class: 'chip hp-close', onclick: () => box.remove() }, 'Close') : null));
  document.body.append(box);
}
function switchHost(id) {
  localStorage.setItem('vsp.host', id);
  S.switching = true;
  if (S.view === 'screen') Screen.hide();
  if (ws) ws.close();
}
async function openWindowList() {
  if (!pairing) return toast('Switching windows works when you connect through the relay (scan the QR code in VS Code).', 3500);
  try {
    relayKeys = relayKeys || await E2E.deriveRoom(pairing.key);
    showWindows(await listHosts(), localStorage.getItem('vsp.host'), switchHost);
  } catch (e) { toast(e.code === 4003 ? 'This pairing is no longer valid. Scan the QR code again.' : 'Couldn\'t load the window list'); }
}
$('#top .titles').addEventListener('click', openWindowList);
if (pairing) $('#top').classList.add('switchable');
async function connectRelay() {
  setConn('', 'Connecting…');
  let hostId;
  try {
    relayKeys = relayKeys || await E2E.deriveRoom(pairing.key);
    hostId = await pickHost();
  } catch (e) { return onDrop({ code: e.code || 1006 }); }
  const ch = new E2E.Channel(relayKeys.c2h, relayKeys.h2c);
  const q = new URLSearchParams({ room: pairing.room, proof: relayKeys.clientProof, host: hostId });
  const sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/c?' + q);
  // Same shape as a WebSocket for call(): send() encrypts, messages are decrypted before handling.
  ws = { get readyState() { return sock.readyState; }, send: (t) => ch.seal(t).then(d => sock.send(d)), close: () => sock.close() };
  sock.onmessage = (e) => ch.open(e.data).then(m => (typeof m === 'string' ? onWire(m) : Screen.onPacket(m))).catch(() => sock.close());
  sock.onclose = (e) => { if (e.code === 4404) localStorage.removeItem('vsp.host'); onDrop(e); };
}
function call(type, data = {}) {
  return new Promise((res, rej) => {
    if (!connected) return rej(new Error('Not connected'));
    const id = nextId++;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, type, ...data }));
  });
}
// Fire and forget: no reply expected (screen input and acks)
function post(type, data = {}) {
  if (connected && ws && ws.readyState === 1) ws.send(JSON.stringify({ type, ...data }));
}
function showLogin(err = '') {
  $('#login').hidden = false; $('#login-err').textContent = err; $('#login-code').focus();
}
$('#login-go').onclick = () => {
  token = $('#login-code').value.trim(); if (!token) return;
  localStorage.setItem('vsp.token', token); $('#login').hidden = true; connect();
};
$('#login-code').onkeydown = (e) => { if (e.key === 'Enter') $('#login-go').click(); };

function onEvent(m) {
  switch (m.type) {
    case 'ready':
      connected = true; backoff = 500; S.hello = m;
      $('#ws-name').textContent = m.workspace;
      setConn('on', m.active ? `Mac: ${rel(m.active.path)}` : 'Connected');
      renderTabs(m.tabs); loadTree();
      S.chatRunning = m.chat.running; rebuildChat(m.chat.events); updateSend();
      if (S.file) openFile(S.file, null, true);
      if (S.view === 'changes') loadChanges();
      Screen.onReady(m.screen);
      break;
    case 'screen.event': Screen.onEvent(m); break;
    case 'doc':
      if (m.path === S.file && !S.pendingWrite) { editor.applyRemote(m.text); setDirty(m.dirty); }
      break;
    case 'saved': if (m.path === S.file) setDirty(false); break;
    case 'active':
      if (m.tabs) renderTabs(m.tabs);
      if (m.active) {
        S.hello.active = m.active;
        setConn('on', `Mac: ${rel(m.active.path)}`);
        if (S.follow && m.active.path !== S.file) openFile(m.active.path, m.active.line, true);
      }
      break;
    case 'files.changed': if (S.view === 'changes') debounce('changes', loadChanges, 800); break;
    case 'chat.event': chatEvent(m.event, true); break;
    case 'chat.status':
      S.chatRunning = m.running; updateSend();
      if (!m.running) { removeThinking(); if (S.view !== 'prompt') $('[data-view=prompt]').classList.add('badge'); }
      break;
    case 'chat.reset': rebuildChat([]); break;
    case 'run.out': if (m.runId === S.runId) termWrite(m.data); break;
    case 'run.exit':
      if (m.runId === S.runId) { termWrite(`\n[exit ${m.code}]\n`, 'exit'); S.runId = null; $('#term-stop').hidden = true; }
      break;
  }
}
const timers = {};
function debounce(key, fn, ms) { clearTimeout(timers[key]); timers[key] = setTimeout(fn, ms); }

// ---------- views ----------
function show(view) {
  if (S.view === 'screen' && view !== 'screen') Screen.hide();
  document.body.classList.remove('chat-over');
  S.view = view;
  document.body.dataset.view = view;
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  document.querySelectorAll('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'prompt') { $('[data-view=prompt]').classList.remove('badge'); updateCtx(); scrollChat(true); }
  if (view === 'changes') { loadChanges(); loadProblems(); }
  if (view === 'screen') Screen.show();
}
document.querySelectorAll('#tabbar button').forEach(b => { b.onclick = () => show(b.dataset.view); });

// Keep layout above the iOS keyboard
function fitViewport() {
  const vv = window.visualViewport; if (!vv) return;
  document.documentElement.style.setProperty('--vh', `${vv.height}px`);
  document.body.classList.toggle('kb', vv.height < window.innerHeight - 120);
  window.scrollTo(0, 0);
}
window.visualViewport && visualViewport.addEventListener('resize', fitViewport);

// ---------- files ----------
async function loadTree() {
  const tree = $('#tree'); tree.innerHTML = '';
  const folders = S.hello.folders;
  if (!folders.length) { tree.append(h('div', { class: 'note' }, 'No folder open in this VS Code window.')); return; }
  if (folders.length === 1) await expand(tree, folders[0].path, 0);
  else for (const f of folders) tree.append(dirNode({ name: f.name, path: f.path }, 0));
}
function dirNode(e, depth) {
  const kids = h('div', { class: 'tree-children', hidden: true });
  const tw = h('span', { class: 'tw' }, '▸');
  const row = h('div', { class: 'item', style: `padding-left:${12 + depth * 16}px` }, tw, h('span', {}, '📁'), h('span', { class: 'name' }, e.name));
  let loaded = false;
  row.onclick = async () => {
    kids.hidden = !kids.hidden; tw.textContent = kids.hidden ? '▸' : '▾';
    if (!loaded) { loaded = true; await expand(kids, e.path, depth + 1); }
  };
  return h('div', {}, row, kids);
}
async function expand(container, dir, depth) {
  try {
    const entries = await call('tree', { path: dir });
    for (const e of entries) {
      container.append(e.dir ? dirNode(e, depth) : h('div', {
        class: 'item', style: `padding-left:${26 + depth * 16}px`, onclick: () => openFile(e.path),
      }, h('span', {}, fileIcon(e.name)), h('span', { class: 'name' }, e.name)));
    }
    if (!entries.length) container.append(h('div', { class: 'item meta', style: `padding-left:${26 + depth * 16}px` }, '(empty)'));
  } catch (err) { toast(err.message); }
}
function fileIcon(n) {
  const ext = n.split('.').pop();
  return ({ js: '🟨', jsx: '🟨', ts: '🟦', tsx: '🟦', json: '🧾', md: '📘', py: '🐍', swift: '🟧', css: '🎨', html: '🌐', png: '🖼', jpg: '🖼', svg: '🖼' })[ext] || '📄';
}
function renderTabs(tabs = []) {
  const el = $('#open-tabs'); el.innerHTML = '';
  for (const p of [...new Set(tabs)].slice(0, 12)) el.append(h('button', { class: 'chip', onclick: () => openFile(p) }, base(p)));
}
$('#file-search').oninput = (e) => debounce('find', async () => {
  const q = e.target.value.trim(); const box = $('#search-results'); box.innerHTML = '';
  if (!q) return;
  try {
    const res = await call('find', { q });
    if (!res.length) box.append(h('div', { class: 'note' }, 'No matches'));
    for (const p of res) box.append(h('div', { class: 'item', onclick: () => openFile(p) }, h('span', {}, fileIcon(p)), h('span', { class: 'name' }, base(p)), h('span', { class: 'meta' }, rel(p))));
  } catch (err) { toast(err.message); }
}, 250);

// ---------- editor ----------
const editor = window.PortalEditor.create($('#editor'), (text) => {
  if (!S.file) return;
  setDirty(true);
  clearTimeout(S.pendingWrite);
  S.pendingWrite = setTimeout(() => flush(false), 350);
});
async function flush(save) {
  clearTimeout(S.pendingWrite); S.pendingWrite = null;
  if (!S.file) return;
  try { const r = await call('write', { path: S.file, text: editor.getText(), save }); setDirty(r.dirty); if (save) toast('Saved'); }
  catch (err) { toast(err.message); }
}
function setDirty(d) { $('#ed-dirty').hidden = !d; }
async function openFile(p, line, quiet) {
  if (S.pendingWrite && S.file) await flush(false);
  // Opening the file that's open on the Mac: start where the Mac cursor is.
  const active = S.hello && S.hello.active;
  if (!line && active && active.path === p && p !== S.file) line = active.line;
  try {
    const r = await call('read', { path: p });
    S.file = p; editor.setDoc(r.text, p); setDirty(r.dirty);
    $('#ed-path').textContent = rel(p);
    if (line) editor.gotoLine(line);
    if (!quiet || S.view === 'files') show('editor');
  } catch (err) { toast(err.message); }
}
$('#ed-save').onclick = () => flush(true);
$('#ed-mac').onclick = () => S.file && call('reveal', { path: S.file, line: editor.selection().line }).then(() => toast('Opened on the Mac')).catch(e => toast(e.message));
$('#ed-follow').onclick = () => {
  S.follow = !S.follow; $('#ed-follow').classList.toggle('on', S.follow);
  if (S.follow && S.hello && S.hello.active) openFile(S.hello.active.path, S.hello.active.line, true);
};
$('#ed-ask').onclick = () => { S.ctxOn = true; show('prompt'); $('#prompt-input').focus(); };
const KEYS = ['⇥', '{', '}', '(', ')', '[', ']', ';', '=', '"', "'", '`', '<', '>', '/', ':', '.', ',', '!', '&', '|', '$', '_', '-', '+', '*', '#', '↶', '↷', '⌄'];
for (const k of KEYS) {
  const b = h('button', {}, k);
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (k === '⇥') editor.insert('  ');
    else if (k === '↶') editor.undo();
    else if (k === '↷') editor.redo();
    else if (k === '⌄') editor.blur();
    else editor.insert(k);
  });
  $('#keys').append(b);
}

// ---------- prompt / chat ----------
const chatEl = $('#chat');
const toolCards = new Map(); // tool_use_id -> card element
let liveEl = null, liveText = '';

function md(text) {
  // Small, safe markdown: code blocks, inline code, bold, headings, lists, links as text.
  const parts = String(text).split(/```/);
  return parts.map((part, i) => {
    if (i % 2) { const nl = part.indexOf('\n'); return `<pre><code>${esc(nl >= 0 ? part.slice(nl + 1) : part)}</code></pre>`; }
    return part.split(/\n{2,}/).map(par => {
      let s = esc(par).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/^#{1,6} (.*)$/gm, '<b>$1</b>').replace(/^\s*[-*] (.*)$/gm, '• $1');
      return s.trim() ? `<p>${s.replace(/\n/g, '<br>')}</p>` : '';
    }).join('');
  }).join('');
}
function scrollChat(force) {
  const nearBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 160;
  if (force || nearBottom) requestAnimationFrame(() => { chatEl.scrollTop = chatEl.scrollHeight; });
}
function emptyChat() {
  chatEl.innerHTML = '';
  const s = (t) => h('button', { onclick: () => { $('#prompt-input').value = t; send(); } }, t);
  chatEl.append(h('div', { class: 'empty-hint' }, h('b', {}, '✨'), 'Claude Code, running in this project on your Mac.'),
    h('div', { class: 'suggest' },
      s('Explain what this file does'), s('Fix the problems VS Code is showing'),
      s('Run the tests and fix any failures'), s('Review my uncommitted changes'),
      s('Commit and push my changes with a good message')));
}
function rebuildChat(events) {
  chatEl.innerHTML = ''; toolCards.clear(); liveEl = null; liveText = '';
  if (!events.length) emptyChat();
  for (const e of events) chatEvent(e, false);
  if (S.chatRunning) addThinking();
  scrollChat(true);
}
function addThinking() { removeThinking(); chatEl.append(h('div', { class: 'thinking', id: 'thinking' }, 'Claude is working')); }
function removeThinking() { const t = $('#thinking'); if (t) t.remove(); }
function append(el) { $('.empty-hint') && (chatEl.innerHTML = ''); const t = $('#thinking'); chatEl.insertBefore(el, t); scrollChat(); }

function toolSummary(name, input = {}) {
  if (input.file_path) return rel(input.file_path);
  if (name === 'Bash') return input.command;
  if (input.pattern) return input.pattern;
  if (name === 'TodoWrite') return `${(input.todos || []).length} tasks`;
  if (input.url) return input.url;
  if (input.description) return input.description;
  return '';
}
function toolBody(name, input = {}) {
  if (name === 'Edit' || name === 'MultiEdit') {
    const edits = input.edits || [input];
    return h('pre', { class: 'diff' }, ...edits.flatMap(e => [
      ...String(e.old_string || '').split('\n').map(l => h('span', { class: 'del' }, `- ${l}`)),
      ...String(e.new_string || '').split('\n').map(l => h('span', { class: 'add' }, `+ ${l}`)),
    ]));
  }
  if (name === 'Write') return h('pre', {}, String(input.content || '').split('\n').slice(0, 60).join('\n'));
  if (name === 'TodoWrite') return h('div', {}, ...(input.todos || []).map(t => h('div', {}, `${t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'} ${t.content}`)));
  if (name === 'Bash') return h('pre', {}, input.command);
  return h('pre', {}, JSON.stringify(input, null, 2));
}
function chatEvent(e, live) {
  if (e.type === 'portal.user') {
    append(h('div', { class: 'msg user' }, e.text, ...(e.attachments || []).map(a => h('div', { class: 'tag' }, `${a.kind === 'video' ? '🎞' : '🖼'} ${a.name}${a.frames ? ` (${a.frames} frames)` : ''}`)), h('span', { class: 'tag' }, [
      { edits: 'Auto-edit', full: 'Full access', plan: 'Plan only' }[e.mode], e.context ? ` · ${base(e.context)}` : ''].join(''))));
    if (live) addThinking();
  } else if (e.type === 'stream_event') {
    const ev = e.event || {};
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
      if (!liveEl) { liveEl = h('div', { class: 'msg assistant' }); liveText = ''; append(liveEl); }
      liveText += ev.delta.text; liveEl.innerHTML = md(liveText); scrollChat();
    }
  } else if (e.type === 'assistant') {
    if (liveEl) { liveEl.remove(); liveEl = null; liveText = ''; }
    for (const c of (e.message && e.message.content) || []) {
      if (c.type === 'text' && c.text.trim()) { const d = h('div', { class: 'msg assistant' }); d.innerHTML = md(c.text); append(d); }
      if (c.type === 'tool_use') {
        const body = h('div', { class: 'tool-body' }, toolBody(c.name, c.input));
        const state = h('span', { class: 'tstate' }, '⏳');
        const card = h('div', { class: 'tool' },
          h('div', { class: 'tool-head', onclick: () => card.classList.toggle('open') },
            h('span', { class: 'tname' }, c.name), h('span', { class: 'tsum' }, toolSummary(c.name, c.input)), state), body);
        card._state = state; card._body = body;
        toolCards.set(c.id, card); append(card);
      }
    }
  } else if (e.type === 'user') {
    for (const c of (e.message && e.message.content) || []) {
      if (c.type !== 'tool_result') continue;
      const card = toolCards.get(c.tool_use_id); if (!card) continue;
      card._state.textContent = c.is_error ? '✗' : '✓';
      if (c.is_error) card.classList.add('err');
      const text = Array.isArray(c.content) ? c.content.map(x => x.text || '').join('\n') : String(c.content || '');
      if (text.trim()) card._body.append(h('pre', {}, text.length > 3000 ? text.slice(0, 3000) + '\n…' : text));
    }
  } else if (e.type === 'result') {
    removeThinking();
    const secs = Math.round((e.duration_ms || 0) / 1000);
    const cost = e.total_cost_usd ? ` · $${e.total_cost_usd.toFixed(2)}` : '';
    append(h('div', { class: `note ${e.is_error ? 'err' : ''}` }, `${e.is_error ? 'Stopped with an error' : 'Done'} · ${secs}s${cost}`));
    const denied = e.permission_denials || [];
    if (denied.length) append(h('div', { class: 'note err' }, `Claude wasn't allowed to: ${denied.map(d => toolSummary(d.tool_name, d.tool_input) || d.tool_name).join(', ')}. Switch to Full access to allow that.`));
  } else if (e.type === 'portal.error') {
    removeThinking(); append(h('div', { class: 'note err' }, e.text));
  } else if (e.type === 'portal.stopped') {
    removeThinking(); append(h('div', { class: 'note' }, 'Stopped'));
  }
}
function updateCtx() {
  const c = $('#ctx');
  c.hidden = !S.file; c.textContent = `📎 ${S.file ? base(S.file) : ''}`; c.classList.toggle('on', S.ctxOn);
}
$('#ctx').onclick = () => { S.ctxOn = !S.ctxOn; updateCtx(); };
function updateSend() {
  const b = $('#send');
  b.textContent = S.chatRunning ? 'Stop' : 'Send'; b.classList.toggle('stop', S.chatRunning);
}
const pendingAtt = []; // {id, name, kind, status}
function renderAtt() {
  const box = $('#attachments'); box.innerHTML = ''; box.hidden = !pendingAtt.length;
  for (const a of pendingAtt) box.append(h('span', { class: 'chip att' + (a.err ? ' err' : '') },
    `${a.kind === 'video' ? '🎞' : '🖼'} ${a.name} ${a.err ? '✗ ' + a.err : a.status}`,
    h('b', { onclick: () => { pendingAtt.splice(pendingAtt.indexOf(a), 1); renderAtt(); } }, ' ×')));
  updateSend();
}
async function uploadFile(file) {
  const a = { name: file.name || 'file', kind: file.type.startsWith('video') ? 'video' : 'image', status: '0%' };
  pendingAtt.push(a); renderAtt();
  try {
    const { id } = await call('attach.begin', { name: a.name, size: file.size });
    const CH = 512 * 1024;
    for (let off = 0; off < file.size; off += CH) {
      const buf = new Uint8Array(await file.slice(off, off + CH).arrayBuffer());
      let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      await call('attach.chunk', { id, data: btoa(bin) });
      a.status = `${Math.round(Math.min(off + CH, file.size) / file.size * 100)}%`; renderAtt();
    }
    a.status = a.kind === 'video' ? 'extracting frames…' : 'processing…'; renderAtt();
    const r = await call('attach.end', { id });
    a.id = id; a.status = r.frames ? `✓ ${r.frames} frames` : '✓'; a.ready = true;
  } catch (err) { a.err = err.message; }
  renderAtt();
}
$('#attach').onclick = () => $('#attach-file').click();
$('#attach-file').onchange = (e) => { for (const f of e.target.files) uploadFile(f); e.target.value = ''; };

async function send() {
  if (S.chatRunning) return call('prompt.stop').catch(e => toast(e.message));
  const input = $('#prompt-input'); const text = input.value.trim(); if (!text) return;
  if (pendingAtt.some(a => !a.ready && !a.err)) return toast('Still uploading…');
  const attachments = pendingAtt.filter(a => a.ready).map(a => a.id);
  const mode = $('#mode').value;
  if (mode === 'full' && !localStorage.getItem('vsp.fullOk')) {
    if (!confirm('Full access lets Claude run any command on your Mac without asking. Continue?')) return;
    localStorage.setItem('vsp.fullOk', '1');
  }
  let context = null;
  if (S.ctxOn && S.file) { const sel = editor.selection(); context = { path: S.file, line: sel.line, selection: sel.text }; }
  input.value = ''; autosize();
  if (S.view !== 'prompt' && !document.body.classList.contains('chat-over')) show('prompt');
  try { if (S.pendingWrite) await flush(false); await call('prompt', { text, mode, context, attachments }); pendingAtt.length = 0; renderAtt(); S.chatRunning = true; updateSend(); }
  catch (err) { input.value = text; toast(err.message, 3500); }
}
$('#send').onclick = send;
$('#prompt-input').onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); };
function autosize() { const t = $('#prompt-input'); t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, window.innerHeight * 0.35)}px`; }
$('#prompt-input').oninput = autosize;
$('#new-chat').onclick = () => call('chat.new').catch(e => toast(e.message));
$('#mode').value = localStorage.getItem('vsp.mode') || 'edits';
$('#mode').onchange = (e) => localStorage.setItem('vsp.mode', e.target.value);

// ---------- changes ----------
async function loadChanges() {
  const box = $('#repos');
  try {
    const repos = await call('git.status');
    box.innerHTML = '';
    if (!repos.length) box.append(h('div', { class: 'note' }, 'No git repository in this workspace.'));
    for (const r of repos) {
      const sync = [r.ahead ? `↑${r.ahead}` : '', r.behind ? `↓${r.behind}` : ''].filter(Boolean).join(' ');
      const el = h('div', { class: 'repo' },
        h('div', { class: 'repo-head' },
          h('b', {}, r.name), h('span', { class: 'chip' }, `⎇ ${r.branch}`), sync && h('span', { class: 'meta' }, sync)),
        h('div', { class: 'repo-actions' },
          h('button', { class: 'chip', onclick: () => askClaude('Review my uncommitted changes, then commit them with a clear message and push.') }, '✨ Commit & push'),
          r.files.length ? h('button', { class: 'chip', onclick: () => commit(r) }, 'Commit') : null,
          h('button', { class: 'chip', onclick: () => push(r) }, 'Push')),
        r.files.length ? null : h('div', { class: 'note' }, 'No changes'),
        ...r.files.map(f => h('div', { class: 'item', onclick: () => showDiff(f) },
          h('span', { class: `st ${f.status.trim()[0] === '?' ? 'U' : f.status.trim()[0]}` }, f.status.trim() === '??' ? 'U' : f.status.trim()),
          h('span', { class: 'name' }, base(f.rel)), h('span', { class: 'meta' }, f.rel))));
      box.append(el);
    }
  } catch (err) { box.innerHTML = ''; box.append(h('div', { class: 'note err' }, err.message)); }
}
function askClaude(text) {
  $('#prompt-input').value = text; S.ctxOn = false; updateCtx();
  if ($('#mode').value === 'plan') $('#mode').value = 'edits';
  show('prompt'); send();
}
async function commit(r) {
  const msg = prompt(`Commit all ${r.files.length} changes in ${r.name}. Message:`);
  if (!msg) return;
  try { await call('git.commit', { root: r.root, message: msg }); toast('Committed'); loadChanges(); } catch (e) { alert(e.message); }
}
async function push(r) {
  if (!confirm(`Push ${r.branch} in ${r.name}?`)) return;
  toast('Pushing…', 10000);
  try { const out = await call('git.push', { root: r.root }); toast('Pushed'); console.log(out); loadChanges(); } catch (e) { $('#toast').hidden = true; alert(e.message); }
}
async function showDiff(f) {
  try {
    const text = await call('git.diff', { path: f.path });
    const pre = h('pre', { class: 'diff' }, ...text.split('\n').map(l => h('span', {
      class: l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : '',
    }, l + '\n')));
    openSheet(f.rel, pre, [h('button', { class: 'chip', onclick: () => { closeSheet(); openFile(f.path); } }, 'Open')]);
  } catch (e) { toast(e.message); }
}
async function loadProblems() {
  const box = $('#problems');
  try {
    const list = await call('diagnostics');
    box.innerHTML = '';
    if (!list.length) box.append(h('div', { class: 'note' }, 'No problems 🎉'));
    else box.append(h('div', { class: 'item', onclick: () => askClaude('Fix the errors and warnings VS Code is reporting in this project.') }, h('span', {}, '✨'), h('span', { class: 'name' }, `Ask Claude to fix ${list.length} problem${list.length > 1 ? 's' : ''}`)));
    for (const d of list.slice(0, 150)) box.append(h('div', { class: 'item', onclick: () => openFile(d.path, d.line) },
      h('span', { class: `sev-${d.severity}` }, d.severity === 'error' ? '⛔' : '⚠️'),
      h('span', { class: 'name' }, d.message), h('span', { class: 'meta' }, `${base(d.path)}:${d.line}`)));
  } catch (e) { box.innerHTML = ''; }
}
$('#refresh-problems').onclick = loadProblems;

// ---------- sheet ----------
function openSheet(title, body, actions = []) {
  $('#sheet-title').textContent = title; $('#sheet-body').innerHTML = ''; $('#sheet-body').append(body);
  $('#sheet-actions').innerHTML = ''; $('#sheet-actions').append(...actions); $('#sheet').hidden = false;
}
function closeSheet() { $('#sheet').hidden = true; }
$('#sheet-close').onclick = closeSheet;
$('#sheet').onclick = (e) => { if (e.target.id === 'sheet') closeSheet(); };

// ---------- terminal ----------
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g;
function termWrite(text, cls) {
  const out = $('#term-out');
  const near = out.scrollHeight - out.scrollTop - out.clientHeight < 80;
  out.append(cls ? h('span', { class: cls }, text) : document.createTextNode(text.replace(ANSI, '')));
  if (out.childNodes.length > 4000) out.firstChild.remove();
  if (near) out.scrollTop = out.scrollHeight;
}
let recent = JSON.parse(localStorage.getItem('vsp.recent') || '["git status","npm test","npm run build","ls -la"]');
function renderChips() {
  const box = $('#term-chips'); box.innerHTML = '';
  for (const c of recent) box.append(h('button', { class: 'chip', onclick: () => { $('#term-input').value = c; runCmd(); } }, c));
}
async function runCmd() {
  const input = $('#term-input'); const cmd = input.value.trim(); if (!cmd) return;
  recent = [cmd, ...recent.filter(c => c !== cmd)].slice(0, 10);
  localStorage.setItem('vsp.recent', JSON.stringify(recent)); renderChips();
  input.value = '';
  try {
    if (S.termTarget === 'mac') { await call('terminal.send', { text: cmd }); termWrite(`→ Mac terminal: ${cmd}\n`, 'cmd'); return; }
    if (S.runId) await call('run.kill', { runId: S.runId });
    termWrite(`$ ${cmd}\n`, 'cmd');
    const r = await call('run', { command: cmd });
    S.runId = r.runId; $('#term-stop').hidden = false;
  } catch (e) { termWrite(`${e.message}\n`, 'exit'); }
}
$('#term-run').onclick = runCmd;
$('#term-input').onkeydown = (e) => { if (e.key === 'Enter') runCmd(); };
$('#term-stop').onclick = () => S.runId && call('run.kill', { runId: S.runId });
$('#term-clear').onclick = () => { $('#term-out').innerHTML = ''; };
$('#term-target').onclick = () => {
  S.termTarget = S.termTarget === 'here' ? 'mac' : 'here';
  $('#term-target').textContent = S.termTarget === 'here' ? 'Run here' : 'Mac terminal';
  $('#term-target').classList.toggle('on', S.termTarget === 'mac');
  toast(S.termTarget === 'here' ? 'Output shows on your phone' : 'Commands go to the VS Code terminal on the Mac');
};
renderChips();

fitViewport();
connect();
