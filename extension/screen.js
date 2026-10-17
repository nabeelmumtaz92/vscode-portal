'use strict';
// Screen sharing: runs the native helper (bin/portal-helper), sends its H.264 frames to the phones that
// are watching, and passes their touches and typing back to the Mac.
//
// Flow control works the same over a direct WebSocket and the relay: the phone acks every frame it
// receives. When frames stay unacked for too long, video is piling up somewhere on the way (weak cell
// signal, busy Wi-Fi), so that phone gets nothing until the backlog clears and then restarts at a
// fresh keyframe, instead of falling seconds behind. Repeated backlogs lower the bitrate; a calm
// network raises it again. VideoToolbox changes bitrate on the fly, so there's no pause.
const { spawn } = require('child_process');
const fs = require('fs');

const PACKET_VIDEO = 1;
const FLAG_KEYFRAME = 1;
const MAX_QUEUE_DELAY_MS = 700;   // backlog beyond the best round trip that counts as congestion
const MAX_INFLIGHT_BYTES = 3 * 1024 * 1024;
const STUCK_MS = 5000;            // nothing acked for this long: start over
const RTT_WINDOW_MS = 30000;
const CONGESTION_EVENTS_TO_LOWER = 2;
const CONGESTION_WINDOW_MS = 15000;
const CALM_BEFORE_RAISE_MS = 20000;
const IDLE_STOP_MS = 60000;       // keep capturing briefly after the last phone leaves, so coming back is instant

const QUALITY = {
  low: { kbps: 1500, maxWidth: 1280, fps: 24 },
  medium: { kbps: 4000, maxWidth: 1920, fps: 30 },
  high: { kbps: 8000, maxWidth: 2560, fps: 30 },
};
const NAMED_KEYS = new Set([
  'Return', 'Tab', 'Backspace', 'Delete', 'Escape', 'Space', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);
const MODIFIERS = new Set(['shift', 'control', 'alt', 'command']);
const BUTTONS = new Set(['left', 'right', 'middle']);
const MAX_CLIPBOARD = 1000000;

const unit = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);
const bounded = (v, limit) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(limit, Math.max(-limit, v)) : 0);
const count = (v) => (Number.isInteger(v) ? Math.min(3, Math.max(1, v)) : 1);

// Validates a phone's input message into a helper command, or null. Without x/y, clicks happen
// where the pointer already is (trackpad mode).
function sanitizeInput(m) {
  const x = unit(m.x), y = unit(m.y);
  const at = x === null || y === null ? {} : { x, y };
  const button = BUTTONS.has(m.button) ? m.button : 'left';
  switch (m.kind) {
    case 'move': return x === null || y === null ? null : { type: 'move', x, y };
    case 'moveBy': return { type: 'moveBy', dx: bounded(m.dx, 1), dy: bounded(m.dy, 1) };
    case 'down': case 'up': case 'click': return { type: m.kind, button, count: count(m.count), ...at };
    case 'scroll': return { type: 'scroll', dx: Math.round(bounded(m.dx, 5000)), dy: Math.round(bounded(m.dy, 5000)) };
    case 'key': {
      if (typeof m.key !== 'string' || (!NAMED_KEYS.has(m.key) && [...m.key].length !== 1)) return null;
      const modifiers = Array.isArray(m.modifiers) ? [...new Set(m.modifiers.filter(x => MODIFIERS.has(x)))] : [];
      return { type: 'key', key: m.key, modifiers };
    }
    case 'text': return typeof m.text === 'string' && m.text.length > 0 && m.text.length <= 2000 ? { type: 'text', text: m.text } : null;
    case 'clipboard': return typeof m.text === 'string' && m.text.length <= MAX_CLIPBOARD ? { type: 'clipboard', text: m.text } : null;
    default: return null;
  }
}

function createScreen({ helperPath, enabled = () => true, log = () => {} }) {
  let proc = null, buf = Buffer.alloc(0);
  let helperState = { screen: null, accessibility: null, displays: [], capture: null, error: null, focus: false };
  const viewers = new Map(); // client -> flow state
  const settings = { screen: 0, quality: 'medium' };
  let kbps = QUALITY.medium.kbps;
  let seq = 0, idleTimer = null, congestionTimes = [], lastCongestionAt = 0, lastBitrateChangeAt = 0;
  let recent = []; // frames since the last keyframe, for a phone that joins mid-stream
  let starting = false; // a capture was asked for and hasn't started yet

  const available = () => process.platform === 'darwin' && fs.existsSync(helperPath);
  const send = (cmd) => { if (proc) proc.stdin.write(JSON.stringify(cmd) + '\n'); };
  const status = () => ({
    enabled: enabled(), available: available(), screen: helperState.screen, accessibility: helperState.accessibility,
    displays: helperState.displays, capture: helperState.capture, focus: helperState.focus, error: helperState.error,
    settings: { ...settings }, kbps,
  });
  const tell = (msg) => { for (const c of viewers.keys()) c.send({ type: 'screen.event', ...msg }); };

  function startHelper() {
    if (proc) return;
    try { fs.chmodSync(helperPath, 0o755); } catch {} // in case unpacking the extension dropped the executable bit
    proc = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    buf = Buffer.alloc(0);
    proc.stdin.on('error', () => {});
    proc.stderr.on('data', d => log(`screen helper: ${String(d).trim()}`));
    proc.stdout.on('data', onHelperData);
    proc.on('error', e => { helperState.error = `Couldn't start the screen helper: ${e.message}`; tell({ event: 'error', message: helperState.error }); });
    proc.on('exit', code => {
      proc = null;
      helperState.capture = null;
      if (viewers.size) {
        helperState.error = `The screen helper stopped (exit ${code}). Retrying…`;
        tell({ event: 'error', message: helperState.error });
        setTimeout(() => { if (viewers.size && !proc) { startHelper(); startCapture(); } }, 2000).unref?.();
      }
    });
  }

  function onHelperData(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 5) {
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) break;
      const kind = buf[4];
      const payload = buf.subarray(5, 4 + len);
      buf = buf.subarray(4 + len);
      if (kind === 1) onFrame(payload);
      else if (kind === 2) { try { onHelperEvent(JSON.parse(payload)); } catch {} }
    }
  }

  function onHelperEvent(e) {
    switch (e.event) {
      case 'ready': case 'permissions':
        helperState.screen = e.screen; helperState.accessibility = e.accessibility; break;
      case 'displays': helperState.displays = e.list || []; break;
      case 'capture': helperState.capture = { w: e.w, h: e.h, screen: e.screen }; helperState.error = null; starting = false; break;
      case 'focus': helperState.focus = !!e.editable; break;
      case 'error': helperState.error = e.message; starting = false; break;
      case 'cursor': case 'clipboard': break;
      default: return;
    }
    tell(e);
  }

  // Packet to the phone: [u8 type][u8 flags][u16 0][u32 seq] then the helper's AVCC NAL units
  function onFrame(payload) {
    const isKey = (payload[0] & FLAG_KEYFRAME) === FLAG_KEYFRAME;
    const packet = Buffer.allocUnsafe(8 + payload.length - 5);
    packet[0] = PACKET_VIDEO; packet[1] = isKey ? FLAG_KEYFRAME : 0; packet.writeUInt16BE(0, 2);
    packet.writeUInt32BE(++seq >>> 0, 4);
    payload.copy(packet, 8, 5);
    if (isKey) recent = [packet];
    else if (recent.length && recent.length < 300) recent.push(packet);

    const now = Date.now();
    let wantKey = false;
    for (const [client, f] of viewers) {
      checkBacklog(client, f, now);
      if (f.congested) continue;
      if (f.needsKey) {
        if (!isKey) { wantKey = true; continue; }
        f.needsKey = false;
      }
      sendPacket(client, f, packet, now);
    }
    if (wantKey && now - (onFrame.keyAskedAt || 0) > 500) { onFrame.keyAskedAt = now; send({ cmd: 'keyframe' }); }
  }

  function sendPacket(client, f, packet, now) {
    const s = packet.readUInt32BE(4);
    f.inflight.push({ seq: s, at: now, bytes: packet.length });
    f.inflightBytes += packet.length;
    client.sendBinary(packet);
  }

  function checkBacklog(client, f, now) {
    const oldest = f.inflight[0];
    if (!oldest) {
      if (f.congested) { f.congested = false; f.needsKey = true; } // drained: resume at a keyframe
      return;
    }
    const age = now - oldest.at;
    if (age > STUCK_MS) { f.inflight = []; f.inflightBytes = 0; f.congested = false; f.needsKey = true; return; }
    if (!f.congested && (age > f.baseRtt + MAX_QUEUE_DELAY_MS || f.inflightBytes > MAX_INFLIGHT_BYTES)) {
      f.congested = true;
      noteCongestion(now);
    }
  }

  function noteCongestion(now) {
    lastCongestionAt = now;
    if (now - lastBitrateChangeAt < 4000) return;
    congestionTimes = congestionTimes.filter(t => now - t < CONGESTION_WINDOW_MS);
    congestionTimes.push(now);
    if (congestionTimes.length < CONGESTION_EVENTS_TO_LOWER) return;
    const lowered = Math.max(400, Math.round(kbps * 0.65));
    if (lowered === kbps) return;
    kbps = lowered; lastBitrateChangeAt = now; congestionTimes = [];
    send({ cmd: 'bitrate', kbps });
    log(`screen: network is congested, ${kbps} kbps`);
  }

  // Calm network: step the bitrate back up towards the chosen quality
  const calmTimer = setInterval(() => {
    const target = QUALITY[settings.quality].kbps;
    const now = Date.now();
    if (!viewers.size || kbps >= target) return;
    if (now - lastCongestionAt < CALM_BEFORE_RAISE_MS || now - lastBitrateChangeAt < CALM_BEFORE_RAISE_MS) return;
    kbps = Math.min(target, Math.round(kbps * 1.3));
    lastBitrateChangeAt = now;
    send({ cmd: 'bitrate', kbps });
  }, 5000);
  calmTimer.unref?.();

  function startCapture() {
    const q = QUALITY[settings.quality];
    startHelper();
    starting = true;
    send({ cmd: 'capture', screen: settings.screen, fps: q.fps, kbps, maxWidth: q.maxWidth });
  }

  return {
    status,
    sanitizeInput,
    // A phone opened the Screen tab
    join(client) {
      if (!enabled()) throw new Error('Screen sharing is off. On the Mac, turn on VSCode Portal › Screen in VS Code settings.');
      if (!available()) throw new Error('Screen sharing needs a Mac.');
      clearTimeout(idleTimer);
      viewers.set(client, { inflight: [], inflightBytes: 0, congested: false, needsKey: true, baseRtt: 200, rttMin: Infinity, rttSince: Date.now() });
      if (!proc || (!helperState.capture && !starting)) startCapture();
      // Start from the latest keyframe right away instead of waiting for the next one
      const f = viewers.get(client);
      if (recent.length && helperState.capture) { f.needsKey = false; const now = Date.now(); for (const p of recent) sendPacket(client, f, p, now); }
      else send({ cmd: 'keyframe' });
      return status();
    },
    leave(client) {
      if (!viewers.delete(client) || viewers.size) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (viewers.size) return;
        send({ cmd: 'stop' });
        helperState.capture = null; recent = [];
      }, IDLE_STOP_MS);
      idleTimer.unref?.();
    },
    ack(client, s) {
      const f = viewers.get(client);
      if (!f || !Number.isInteger(s)) return;
      const now = Date.now();
      while (f.inflight.length && f.inflight[0].seq <= s) {
        const item = f.inflight.shift();
        f.inflightBytes -= item.bytes;
        if (item.seq === s) {
          // Best round trip over the last 30 s: the network's delay with nothing queued
          const rtt = now - item.at;
          f.rttMin = Math.min(f.rttMin, rtt);
          f.baseRtt = Math.min(f.baseRtt, rtt);
          if (now - f.rttSince > RTT_WINDOW_MS) { f.baseRtt = Math.min(f.rttMin, 400); f.rttMin = Infinity; f.rttSince = now; }
        }
      }
      if (f.congested && !f.inflight.length) { f.congested = false; f.needsKey = true; send({ cmd: 'keyframe' }); }
    },
    configure({ screen, quality }, client) {
      let restart = false;
      if (Number.isInteger(screen) && screen >= 0 && screen < Math.max(1, helperState.displays.length) && screen !== settings.screen) {
        settings.screen = screen; restart = true;
      }
      if (QUALITY[quality] && quality !== settings.quality) {
        settings.quality = quality; kbps = QUALITY[quality].kbps; restart = true;
      }
      if (restart && viewers.size) {
        recent = [];
        for (const f of viewers.values()) { f.needsKey = true; f.inflight = []; f.inflightBytes = 0; f.congested = false; }
        startCapture();
      }
      return status();
    },
    input(msg) {
      const cmd = sanitizeInput(msg);
      if (cmd && proc) send(cmd);
    },
    // Ask macOS for Screen Recording and Accessibility (shows the system prompts once)
    requestPermissions() {
      if (!available()) return;
      startHelper();
      send({ cmd: 'permissions', prompt: true });
    },
    close() {
      clearInterval(calmTimer);
      clearTimeout(idleTimer);
      viewers.clear();
      if (proc) { proc.kill(); proc = null; }
    },
  };
}

module.exports = { createScreen, sanitizeInput, QUALITY };
