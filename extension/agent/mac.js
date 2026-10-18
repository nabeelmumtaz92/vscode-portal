'use strict';
// Talks to bin/portal-mac (native/mac-helper.swift): apps, windows, accessibility, mouse, keyboard, media.
// One process, started on first use and restarted if it exits. Requests and replies are JSON lines with an id.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

function createMac(binary) {
  let proc = null, nextId = 1;
  const pending = new Map();

  function start() {
    if (proc) return proc;
    try { fs.chmodSync(binary, 0o755); } catch {}
    proc = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    proc.stdin.on('error', () => {});
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      const p = pending.get(m.id); if (!p) return;
      pending.delete(m.id);
      m.ok ? p.resolve(m.result) : p.reject(new Error(m.error || 'The Mac helper failed'));
    });
    proc.on('exit', () => {
      proc = null;
      for (const p of pending.values()) p.reject(new Error('The Mac helper stopped'));
      pending.clear();
    });
    proc.on('error', () => {});
    return proc;
  }

  // call('windows'), call('mouse', { action: 'click', x, y })...
  function call(cmd, args = {}, timeout = 15000) {
    const p = start();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`The Mac didn't answer (${cmd})`)); }, timeout);
      pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      p.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }

  return { call, close() { if (proc) proc.kill(); proc = null; } };
}

const run = (file, args, opts = {}) => new Promise((resolve, reject) =>
  execFile(file, args, { maxBuffer: 50 * 1024 * 1024, timeout: 20000, ...opts }, (err, stdout, stderr) =>
    err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout))));

// A JPEG of part of the desktop (global points), at most maxSide pixels on its longer side.
// Returns { data (base64), width, height } in image pixels.
async function screenshot(rect, maxSide = 1366) {
  const file = path.join(os.tmpdir(), `vsp-shot-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  try {
    const r = [rect.x, rect.y, rect.w, rect.h].map(Math.round).join(',');
    await run('/usr/sbin/screencapture', ['-x', '-C', '-t', 'jpg', '-R', r, file]);
    await run('/usr/bin/sips', ['-Z', String(maxSide), '-s', 'formatOptions', '70', file]);
    const info = await run('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
    const width = +(info.match(/pixelWidth: (\d+)/) || [])[1], height = +(info.match(/pixelHeight: (\d+)/) || [])[1];
    return { data: fs.readFileSync(file).toString('base64'), width, height };
  } finally { fs.rm(file, { force: true }, () => {}); }
}

module.exports = { createMac, screenshot, run };
