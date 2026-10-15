'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');
const { createPortalServer } = require('../server');

function fakeHost(root) {
  const listeners = [];
  return {
    workspaceName: () => 'Test', folders: () => [{ name: 'proj', path: root }], activeFile: () => null, openTabs: () => [],
    readDoc: async () => null,
    writeDoc: async (p, text, { save }) => { if (save) fs.writeFileSync(p, text); return { dirty: !save }; },
    reveal: async () => {}, diagnostics: () => [], sendToTerminal: () => {}, findFiles: async () => [],
    onEvent: (cb) => listeners.push(cb),
  };
}
function client(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let id = 0; const pending = new Map(); const events = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('close', (code) => reject(new Error(`closed ${code}`)));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'ready') resolve({ hello: m, events, ws, call: (type, d = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, type, ...d })); }) });
      else if (m.id) { const p = pending.get(m.id); m.ok ? p.res(m.result) : p.rej(new Error(m.error)); }
      else events.push(m);
    });
  });
}

test('auth, files, git, run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vsp-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const portal = createPortalServer({ host: fakeHost(root), token: 'secret', claudeBin: null });
  const port = await portal.listen(0);
  try {
    await assert.rejects(client(port, 'wrong'), /4001/);
    const c = await client(port, 'secret');
    assert.equal(c.hello.workspace, 'Test');
    const tree = await c.call('tree', { path: root });
    assert.deepEqual(tree.map(e => e.name), ['a.txt']);
    assert.equal((await c.call('read', { path: path.join(root, 'a.txt') })).text, 'hello\n');
    await assert.rejects(c.call('read', { path: '/etc/hosts' }), /outside/);
    await c.call('write', { path: path.join(root, 'a.txt'), text: 'changed\n', save: true });
    const repos = await c.call('git.status');
    assert.equal(repos[0].files[0].rel, 'a.txt');
    assert.match(await c.call('git.diff', { path: path.join(root, 'a.txt') }), /\+changed/);
    const { runId } = await c.call('run', { command: 'echo hi-from-run' });
    await new Promise(r => setTimeout(r, 1500));
    assert.ok(c.events.some(e => e.type === 'run.out' && e.runId === runId && e.data.includes('hi-from-run')));
    await assert.rejects(c.call('prompt', { text: 'hi' }), /Claude Code not found/);
    c.ws.removeAllListeners('close'); c.ws.close();
  } finally { await portal.close(); }
});

test('falls back to the next port when busy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vsp-'));
  const a = createPortalServer({ host: fakeHost(root), token: 't', claudeBin: null });
  const b = createPortalServer({ host: fakeHost(root), token: 't', claudeBin: null });
  const pa = await a.listen(0);
  const pb = await b.listen(pa);
  assert.equal(pb, pa + 1);
  await a.close(); await b.close();
});
