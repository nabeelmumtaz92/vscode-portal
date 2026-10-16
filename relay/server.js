'use strict';
// VSCode Portal relay: connects phones to their computers from anywhere.
// It only forwards end-to-end encrypted messages. It never has the pairing key, so it can't read
// code, prompts or files. Also serves the phone web app.
//
//   computer (extension) ── wss /h ──▶ relay ◀── wss /c ── phone
//
// Rooms are identified by a random id. A computer proves it owns a room with hostProof (only a hash is
// stored), and tells the relay the hash of the client proof that phones must present.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8790;
const WEB_DIR = path.resolve(process.env.WEB_DIR || path.join(__dirname, '..', 'extension', 'web'));
const MAX_MSG = 12 * 1024 * 1024;
const MAX_HOSTS_PER_ROOM = 20;
const MAX_CLIENTS_PER_HOST = 8;
const MAX_ROOMS = 200000;
const ROOM_TTL = 30 * 24 * 3600 * 1000; // forget rooms with no computer for 30 days

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
};
const RE = { room: /^[A-Za-z0-9_-]{16,64}$/, id: /^[a-f0-9]{8,64}$/, proof: /^[a-f0-9]{64}$/ };
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function createRelay({ log = console.log } = {}) {
  const rooms = new Map(); // room -> { hostProofHash, clientProofHash, hosts: Map(id -> host), seen }
  const failures = new Map(); // ip -> { count, since }
  const stats = { hosts: 0, clients: 0 };

  const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const locked = (ip) => { const f = failures.get(ip); return f && f.count >= 30 && Date.now() - f.since < 10 * 60 * 1000; };
  const fail = (ip) => {
    const f = failures.get(ip);
    if (!f || Date.now() - f.since > 10 * 60 * 1000) failures.set(ip, { count: 1, since: Date.now() });
    else f.count++;
  };
  const clientOk = (room, proof) => room && RE.proof.test(proof || '') && eq(sha(proof), room.clientProofHash);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache' };
    if (url.pathname === '/health') { res.writeHead(200, headers); return res.end(JSON.stringify({ ok: true, rooms: rooms.size, ...stats })); }
    if (url.pathname === '/hosts') {
      const ip = ipOf(req);
      const room = rooms.get(url.searchParams.get('room') || '');
      if (locked(ip) || !clientOk(room, url.searchParams.get('proof'))) {
        fail(ip);
        res.writeHead(404, { ...headers, 'Content-Type': 'application/json' });
        return res.end('{"error":"unknown pairing"}');
      }
      const list = [...room.hosts.entries()].map(([id, h]) => ({ id, label: h.label, since: h.since }));
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(list));
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.join(WEB_DIR, path.normalize(rel));
    if (!file.startsWith(WEB_DIR + path.sep)) { res.writeHead(403, headers); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, headers); return res.end('Not found'); }
      res.writeHead(200, { ...headers, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/h' && url.pathname !== '/c') return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('error', () => {});
      if (url.pathname === '/h') onHost(ws, url.searchParams, ipOf(req));
      else onClient(ws, url.searchParams, ipOf(req));
    });
  });

  function onHost(ws, q, ip) {
    const roomId = q.get('room') || '', id = q.get('id') || '', proof = q.get('proof') || '', cp = q.get('cp') || '';
    const label = (q.get('label') || '').slice(0, 4096);
    if (locked(ip) || !RE.room.test(roomId) || !RE.id.test(id) || !RE.proof.test(proof) || !RE.proof.test(cp)) { fail(ip); return ws.close(4003, 'bad request'); }
    let room = rooms.get(roomId);
    if (!room) {
      if (rooms.size >= MAX_ROOMS) return ws.close(4429, 'relay full');
      room = { hostProofHash: sha(proof), clientProofHash: cp, hosts: new Map(), seen: Date.now() };
      rooms.set(roomId, room);
    } else if (!eq(sha(proof), room.hostProofHash)) { fail(ip); return ws.close(4003, 'wrong proof'); }
    room.clientProofHash = cp;
    room.seen = Date.now();
    const old = room.hosts.get(id);
    if (old) old.ws.close(4409, 'replaced');
    else if (room.hosts.size >= MAX_HOSTS_PER_ROOM) return ws.close(4429, 'too many computers');

    const host = { ws, label, clients: new Map(), next: 1, since: Date.now() };
    room.hosts.set(id, host);
    stats.hosts++;
    ws.on('message', raw => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      const c = host.clients.get(String(m.c));
      if (!c) return;
      if (m.t === 'msg' && typeof m.d === 'string') c.send(m.d);
      else if (m.t === 'kick') c.close(4000 + Math.min(999, Math.max(0, +m.code || 1)), 'closed by computer');
    });
    ws.on('close', () => {
      stats.hosts--;
      for (const c of host.clients.values()) c.close(4404, 'computer went offline');
      if (room.hosts.get(id) === host) room.hosts.delete(id);
      room.seen = Date.now();
    });
  }

  function onClient(ws, q, ip) {
    const room = rooms.get(q.get('room') || '');
    if (locked(ip) || !clientOk(room, q.get('proof'))) { fail(ip); return ws.close(4003, 'unknown pairing'); }
    const host = room.hosts.get(q.get('host') || '');
    if (!host) return ws.close(4404, 'computer offline');
    if (host.clients.size >= MAX_CLIENTS_PER_HOST) return ws.close(4429, 'too many phones');
    const cid = String(host.next++);
    host.clients.set(cid, ws);
    stats.clients++;
    const toHost = (m) => { if (host.ws.readyState === 1) host.ws.send(JSON.stringify(m)); };
    toHost({ t: 'join', c: cid });
    ws.on('message', raw => toHost({ t: 'msg', c: cid, d: raw.toString() }));
    ws.on('close', () => { stats.clients--; host.clients.delete(cid); toHost({ t: 'leave', c: cid }); });
  }

  // Keepalive (proxies drop idle sockets) and cleanup
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
    const now = Date.now();
    for (const [id, r] of rooms) if (!r.hosts.size && now - r.seen > ROOM_TTL) rooms.delete(id);
    for (const [ip, f] of failures) if (now - f.since > 10 * 60 * 1000) failures.delete(ip);
  }, 25000);
  timer.unref();

  return {
    server,
    listen: (port = PORT) => new Promise(r => server.listen(port, () => { log(`relay on :${server.address().port}`); r(server.address().port); })),
    close: () => { clearInterval(timer); for (const ws of wss.clients) ws.terminate(); return new Promise(r => server.close(() => r())); },
  };
}

if (require.main === module) createRelay().listen();
module.exports = { createRelay };
