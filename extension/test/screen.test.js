'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createScreen, sanitizeInput } = require('../screen');
const E2E = require('../web/e2e.js');

// A stand-in for bin/portal-helper: logs commands to a file, and sends a keyframe then delta frames
// every 20 ms once capture starts.
function fakeHelper(dir) {
  const file = path.join(dir, 'helper.js');
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require('fs');
const out = (kind, payload) => { const h = Buffer.alloc(5); h.writeUInt32BE(payload.length + 1); h[4] = kind; process.stdout.write(Buffer.concat([h, payload])); };
const ev = (o) => out(2, Buffer.from(JSON.stringify(o)));
ev({ event: 'ready', screen: true, accessibility: true });
ev({ event: 'displays', list: [{ w: 100, h: 50, main: true }] });
let timer = null, key = true;
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  fs.appendFileSync(${JSON.stringify(path.join(dir, 'cmds.log'))}, line + '\\n');
  const c = JSON.parse(line);
  if (c.cmd === 'capture') {
    ev({ event: 'capture', state: 'started', w: 100, h: 50, screen: 0 });
    clearInterval(timer);
    timer = setInterval(() => { out(1, Buffer.from([key ? 1 : 0, 0, 0, 0, 0, 0, 0, 0, 2, 0x65, 0])); key = false; }, 20);
  }
  if (c.cmd === 'keyframe') key = true;
  if (c.cmd === 'stop') clearInterval(timer);
});
`, { mode: 0o755 });
  return file;
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const cmds = (dir) => { try { return fs.readFileSync(path.join(dir, 'cmds.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };

test('sanitizeInput accepts known commands and rejects the rest', () => {
  assert.deepEqual(sanitizeInput({ kind: 'click', x: 0.5, y: 2, button: 'right', count: 2 }), { type: 'click', button: 'right', count: 2, x: 0.5, y: 1 });
  assert.deepEqual(sanitizeInput({ kind: 'click' }), { type: 'click', button: 'left', count: 1 });
  assert.deepEqual(sanitizeInput({ kind: 'key', key: 'c', modifiers: ['command', 'hyper'] }), { type: 'key', key: 'c', modifiers: ['command'] });
  assert.equal(sanitizeInput({ kind: 'key', key: 'rm -rf' }), null);
  assert.equal(sanitizeInput({ kind: 'move' }), null);
  assert.equal(sanitizeInput({ kind: 'cmd', cmd: 'stop' }), null);
  assert.deepEqual(sanitizeInput({ kind: 'scroll', dx: 1e9, dy: -3.4 }), { type: 'scroll', dx: 5000, dy: -3 });
});

test('binary messages survive the end-to-end channel, in order with text', async () => {
  const keys = await E2E.deriveRoom(E2E.newKey());
  const tx = new E2E.Channel(keys.h2c, keys.c2h), rx = new E2E.Channel(keys.c2h, keys.h2c);
  const a = await tx.seal('{"x":1}'), b = await tx.sealBytes(new Uint8Array([0, 1, 2, 255])), c = await tx.seal('hi');
  assert.equal(await rx.open(a), '{"x":1}');
  assert.deepEqual([...(await rx.open(b))], [0, 1, 2, 255]);
  assert.equal(await rx.open(c), 'hi');
  // A replayed message is rejected
  await assert.rejects(rx.open(b), /out of order/);
});

test('flow control: a phone that stops acking is paused, then resumes at a keyframe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsp-screen-'));
  const screen = createScreen({ helperPath: fakeHelper(dir) });
  const got = [];
  let acking = true;
  const client = { send: () => {}, sendBinary: (b) => {
    const f = { seq: b.readUInt32BE(4), key: (b[1] & 1) === 1 };
    got.push(f);
    if (acking) setImmediate(() => screen.ack(client, f.seq));
  } };
  // Not on a Mac the helper still runs, since it's a stand-in
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  try {
    screen.join(client);
    for (let i = 0; i < 100 && got.length < 10; i++) await wait(50);
    assert.ok(got.length >= 10, 'frames flow');
    assert.ok(got[0].key, 'starts at a keyframe');
    acking = false;

    // Stop acking: video piles up, so frames stop after about the queue-delay limit
    const before = got.length;
    await wait(1500);
    const sentWhileStuck = got.length - before;
    assert.ok(sentWhileStuck < 50, `paused (sent ${sentWhileStuck})`);
    const atPause = got.length;
    await wait(300);
    assert.equal(got.length, atPause, 'nothing sent while congested');

    // Ack everything: it resumes, starting with a keyframe it asks the helper for
    screen.ack(client, got[got.length - 1].seq);
    await wait(300);
    assert.ok(got.length > atPause, 'resumed');
    assert.ok(got[atPause].key, 'resumes at a keyframe');
    assert.ok(cmds(dir).some(c => c.cmd === 'keyframe'));
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
    screen.close();
  }
});

test('join is refused while screen sharing is turned off', () => {
  const screen = createScreen({ helperPath: '/nonexistent', enabled: () => false });
  assert.throws(() => screen.join({}), /Screen sharing is off/);
  screen.close();
});
