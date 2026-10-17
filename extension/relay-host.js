'use strict';
// Connects this VS Code window to a VSCode Portal relay, so a paired phone can reach it from anywhere
// without Tailscale. Everything is end-to-end encrypted with the pairing key (see web/e2e.js); the relay
// only forwards ciphertext and can't read code, prompts or files.
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const E2E = require('./web/e2e.js');

// A WebSocket-shaped wrapper around one phone's encrypted channel, for portal.attach().
class RelayConn extends EventEmitter {
  constructor(link, cid, ch) { super(); this.link = link; this.cid = cid; this.ch = ch; this.readyState = 1; }
  send(text) {
    if (this.readyState !== 1) return;
    this.ch.seal(text).then(d => this.link.send({ t: 'msg', c: this.cid, d })).catch(() => this.close(4002, 'encrypt failed'));
  }
  sendBinary(bytes) {
    if (this.readyState !== 1) return;
    this.ch.sealBytes(bytes).then(d => this.link.send({ t: 'msg', c: this.cid, d })).catch(() => this.close(4002, 'encrypt failed'));
  }
  close(code = 1000) {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.link.send({ t: 'kick', c: this.cid, code: code >= 4000 ? code - 4000 : 0 });
    this.emit('close');
  }
  gone() { if (this.readyState === 1) { this.readyState = 3; this.emit('close'); } }
}

// relayUrl: e.g. https://relay.example.com. pairing: { key, room }. hostId: stable id for this window.
function connectRelay({ relayUrl, pairing, hostId, label, portal, log = () => {} }) {
  let ws = null, stopped = false, backoff = 1000, timer = null, keys = null, state = 'connecting';
  const conns = new Map();
  const emitter = new EventEmitter();
  const setState = (s) => { state = s; emitter.emit('state', s); };
  const link = { send: (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); } };

  async function open() {
    if (stopped) return;
    try {
      keys = keys || await E2E.deriveRoom(pairing.key);
      const sealed = await E2E.sealLabel(keys.label, label());
      const base = relayUrl.replace(/^http/, 'ws').replace(/\/$/, '');
      const q = new URLSearchParams({ room: pairing.room, id: hostId, proof: keys.hostProof, cp: keys.clientProofHash, label: sealed });
      ws = new WebSocket(`${base}/h?${q}`, { maxPayload: 12 * 1024 * 1024 });
    } catch (e) { log(`relay: ${e.message}`); return retry(); }
    ws.on('open', () => { backoff = 1000; setState('online'); log('relay: online'); });
    ws.on('message', async raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'join') {
        const conn = new RelayConn(link, m.c, new E2E.Channel(keys.h2c, keys.c2h));
        conns.set(m.c, conn);
        portal.attach(conn, `relay:${m.c}`, { authed: true });
      } else if (m.t === 'msg') {
        const conn = conns.get(m.c);
        if (!conn) return;
        try { conn.emit('message', await conn.ch.open(m.d)); }
        catch { conn.close(4002, 'bad message'); } // not from a paired phone, or tampered with
      } else if (m.t === 'leave') {
        const conn = conns.get(m.c); conns.delete(m.c);
        if (conn) conn.gone();
      }
    });
    ws.on('close', (code) => {
      for (const c of conns.values()) c.gone();
      conns.clear();
      if (code === 4409) { setState('replaced'); return; } // the same window connected again elsewhere
      retry();
    });
    ws.on('error', (e) => log(`relay: ${e.message}`));
  }
  function retry() {
    if (stopped) return;
    setState('offline');
    clearTimeout(timer);
    timer = setTimeout(open, backoff);
    backoff = Math.min(backoff * 2, 30000);
  }
  open();
  return {
    get state() { return state; },
    onState: (cb) => emitter.on('state', cb),
    close() { stopped = true; clearTimeout(timer); for (const c of conns.values()) c.gone(); if (ws) ws.close(); },
  };
}

module.exports = { connectRelay };
