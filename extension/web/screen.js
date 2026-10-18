'use strict';
// Screen tab: the Mac's screen as H.264 video (decoded with WebCodecs), with touch, trackpad and keyboard
// control. Uses app.js's call(), post(), show(), toast() and $().
//
// Touch mode works like a phone: tap to click where you tap, swipe to scroll (with momentum), or, when
// zoomed in, swipe to move around. Trackpad mode works like a laptop trackpad: drag to nudge the pointer
// (slow is precise, fast goes far) and tap to click where it is.
// Both modes: touch and hold to right-click, or hold then drag to click-drag (select text, move windows) ·
// two-finger tap: right-click · two-finger swipe: scroll · pinch: zoom.
const Screen = (() => {
  const stage = $('#scr-stage'), layer = $('#scr-layer'), canvas = $('#scr-canvas'), ctx = canvas.getContext('2d');
  const ring = $('#scr-cursor'), msgEl = $('#scr-msg'), kbd = $('#scr-kbd');
  const supported = 'VideoDecoder' in window;

  let active = false, joined = false, status = null;
  let decoder = null, codec = null, waitingForKey = true, frameTime = 0;
  let videoW = 0, videoH = 0;
  let trackpad = localStorage.getItem('vsp.trackpad') === '1';
  let zoom = 1, offX = 0, offY = 0;
  let cursor = null; // remote pointer, 0-1 within the video
  let macFocus = false, clipText = null;
  const sticky = new Set(); // modifiers waiting for the next key

  // ---------- messages ----------
  function message(text, actions = []) {
    msgEl.innerHTML = '';
    if (!text) { msgEl.hidden = true; return; }
    msgEl.append(h('p', {}, text), ...actions);
    msgEl.hidden = false;
  }

  function explain(st) {
    if (!supported) return message('The Screen tab needs iOS 16.4 or later (or a recent Chrome, Edge or Safari).');
    if (!st) return message('Screen sharing needs a Mac with the VSCode Portal extension.');
    if (!st.enabled) return message('Screen sharing is off. On the Mac, run "VSCode Portal: Turn On Screen Sharing" in VS Code (⇧⌘P).');
    if (!st.available) return message('Screen sharing needs a Mac.');
    if (st.screen === false) return message('macOS hasn\'t allowed VS Code to record the screen. On the Mac: System Settings › Privacy & Security › Screen Recording › turn on Visual Studio Code, then quit and reopen VS Code.');
    if (st.error) return message(st.error);
    if (!videoW) return message('Waiting for the screen…');
    message(null);
  }

  function renderPickers(st) {
    const pick = $('#scr-pick');
    const list = (st && st.displays) || [];
    pick.innerHTML = '';
    list.forEach((d, i) => pick.append(h('option', { value: i }, list.length > 1 ? `Screen ${i + 1}${d.main ? ' (main)' : ''}` : 'Screen')));
    if (list.length > 1) pick.append(h('option', { value: 'all' }, 'All screens'));
    pick.hidden = list.length < 2;
    if (st && st.settings) {
      pick.value = String(st.settings.screen);
      $('#sp-q').value = st.settings.quality; $('#sp-fps').value = st.settings.fps;
      $('#sp-q-out').textContent = `${st.settings.quality}%`; $('#sp-fps-out').textContent = `${st.settings.fps} fps`;
    }
  }

  // ---------- status and settings ----------
  let stats = null;
  function renderStats() {
    const lat = $('#scr-lat'), dot = $('#scr-lat-dot');
    const rtt = stats && stats.rtt;
    lat.textContent = rtt == null ? '– ms' : `${rtt} ms`;
    dot.className = rtt == null ? '' : rtt < 120 ? 'good' : rtt < 300 ? 'ok' : 'bad';
    if ($('#scr-panel').hidden) return;
    const st = status || {};
    const rows = [
      ['Computer', st.computer || '–'],
      ['Resolution', stats && stats.w ? `${stats.w} × ${stats.h}` : '–'],
      ['Frame rate', stats ? `${stats.fps} fps (up to ${stats.targetFps})` : '–'],
      ['Bitrate', stats ? `${(stats.kbps / 1000).toFixed(1)} Mbps${stats.bitrate < streamKbps(stats.quality) ? ' · lowered for the network' : ''}` : '–'],
      ['Latency', rtt == null ? '–' : `${rtt} ms round trip${stats.congested ? ' · catching up' : ''}`],
    ];
    $('#sp-status').innerHTML = '';
    for (const [k, v] of rows) $('#sp-status').append(h('dt', {}, k), h('dd', {}, v));
  }
  const streamKbps = (q) => Math.round(1000 + ((q - 30) / 70) * 9000);
  $('#scr-stat').onclick = () => { $('#scr-panel').hidden = false; renderStats(); };
  $('#sp-close').onclick = () => { $('#scr-panel').hidden = true; };
  $('#scr-panel').addEventListener('click', (e) => { if (e.target.id === 'scr-panel') $('#scr-panel').hidden = true; });
  const config = (data) => call('screen.config', data).then(st => { status = st; renderPickers(st); }).catch(err => toast(err.message));
  $('#sp-q').oninput = (e) => { $('#sp-q-out').textContent = `${e.target.value}%`; };
  $('#sp-q').onchange = (e) => config({ quality: Number(e.target.value) });
  $('#sp-fps').oninput = (e) => { $('#sp-fps-out').textContent = `${e.target.value} fps`; };
  $('#sp-fps').onchange = (e) => config({ fps: Number(e.target.value) });
  // Open the keyboard when a text box on the Mac gets focus, close it when focus leaves (in the app)
  let autoKbd = localStorage.getItem('vsp.autoKbd') !== '0';
  $('#sp-autokbd').checked = autoKbd;
  $('#sp-autokbd').onchange = (e) => { autoKbd = e.target.checked; localStorage.setItem('vsp.autoKbd', autoKbd ? '1' : '0'); };

  async function join() {
    if (!active || joined || !connected) return;
    if (!supported) return explain(null);
    joined = true;
    message('Connecting to the screen…');
    try {
      status = await call('screen.start');
      renderPickers(status);
      explain(status);
      if (status.accessibility === false) toast('macOS is blocking mouse and keyboard control. Allow VS Code in System Settings › Privacy & Security › Accessibility.', 6000);
    } catch (e) {
      joined = false;
      status = (S.hello && S.hello.screen) || status;
      if (status) status = { ...status, error: e.message };
      message(e.message);
    }
  }

  function leave() {
    if (joined) post('screen.stop');
    joined = false;
    resetDecoder();
  }

  // ---------- video ----------
  const hex = (b) => b.toString(16).padStart(2, '0');
  function resetDecoder() {
    if (decoder && decoder.state !== 'closed') { try { decoder.close(); } catch {} }
    decoder = null; codec = null; waitingForKey = true;
  }
  function configure(newCodec) {
    resetDecoder();
    codec = newCodec;
    decoder = new VideoDecoder({
      output: (frame) => {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth; canvas.height = frame.displayHeight;
          videoW = frame.displayWidth; videoH = frame.displayHeight;
          layout();
        }
        ctx.drawImage(frame, 0, 0);
        frame.close();
        if (!msgEl.hidden && status && !status.error) message(null);
      },
      error: () => resetDecoder(), // the next keyframe carries the SPS/PPS and sets it up again
    });
    // Without a description the decoder expects Annex B (start codes), which onPacket converts to
    decoder.configure({ codec, optimizeForLatency: true });
  }

  // [u8 type][u8 flags][u16][u32 seq] then AVCC NAL units
  function onPacket(packet) {
    if (packet[0] !== 1 || packet.length < 8) return;
    const seq = ((packet[4] << 24) | (packet[5] << 16) | (packet[6] << 8) | packet[7]) >>> 0;
    post('screen.ack', { seq });
    if (!active || !supported) return;
    const isKey = (packet[1] & 1) === 1;
    const data = packet.slice(8);
    let sps = null;
    for (let i = 0; i + 4 <= data.length;) {
      const len = ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0;
      if ((data[i + 4] & 0x1f) === 7) sps = data.subarray(i + 4, i + 4 + len);
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 1;
      i += 4 + len;
    }
    if (sps) {
      const c = `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
      if (!decoder || c !== codec) configure(c);
    }
    if (!decoder || decoder.state !== 'configured') return;
    if (waitingForKey) { if (!isKey) return; waitingForKey = false; }
    // Decoding fell behind: skip to the next keyframe rather than lag
    if (decoder.decodeQueueSize > 5 && !isKey) { waitingForKey = true; return; }
    frameTime += 33333;
    try { decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: frameTime, data })); }
    catch { resetDecoder(); }
  }

  // ---------- geometry ----------
  // Where the picture sits in the stage, unzoomed (contain)
  function videoRect() {
    const W = stage.clientWidth, H = stage.clientHeight;
    if (!videoW || !videoH || !W || !H) return null;
    const s = Math.min(W / videoW, H / videoH);
    const w = videoW * s, h2 = videoH * s;
    return { x: (W - w) / 2, y: (H - h2) / 2, w, h: h2, W, H };
  }
  function layout() {
    const r = videoRect();
    if (!r) return;
    canvas.style.left = `${r.x}px`; canvas.style.top = `${r.y}px`;
    canvas.style.width = `${r.w}px`; canvas.style.height = `${r.h}px`;
    clampOffset(); applyTransform();
  }
  function clampOffset() {
    const W = stage.clientWidth, H = stage.clientHeight;
    const mx = (W * (zoom - 1)) / 2, my = (H * (zoom - 1)) / 2;
    offX = Math.min(mx, Math.max(-mx, offX)); offY = Math.min(my, Math.max(-my, offY));
  }
  function applyTransform() {
    layer.style.transform = `translate(${offX}px, ${offY}px) scale(${zoom})`;
    updateRing();
  }
  // Stage point → 0-1 on the Mac's screen
  function toRemote(px, py) {
    const r = videoRect(); if (!r) return null;
    const cx = r.W / 2, cy = r.H / 2;
    const ux = cx + (px - cx - offX) / zoom, uy = cy + (py - cy - offY) / zoom;
    return { x: Math.min(1, Math.max(0, (ux - r.x) / r.w)), y: Math.min(1, Math.max(0, (uy - r.y) / r.h)) };
  }
  // 0-1 on the Mac's screen → stage point
  function toStage(p) {
    const r = videoRect(); if (!r || !p) return null;
    const cx = r.W / 2, cy = r.H / 2;
    return { x: cx + (r.x + p.x * r.w - cx) * zoom + offX, y: cy + (r.y + p.y * r.h - cy) * zoom + offY };
  }
  function updateRing() {
    const p = cursor && cursor.visible !== false ? toStage(cursor) : null;
    ring.hidden = !p;
    if (p) ring.style.transform = `translate(${p.x - 17}px, ${p.y - 17}px)`;
  }
  // Zoomed in with the trackpad: slide the view so the pointer stays away from the edges
  function keepCursorInView() {
    if (zoom <= 1.01 || !cursor) return;
    const p = toStage(cursor); if (!p) return;
    const W = stage.clientWidth, H = stage.clientHeight, mx = W * 0.2, my = H * 0.2;
    let dx = 0, dy = 0;
    if (p.x < mx) dx = mx - p.x; else if (p.x > W - mx) dx = W - mx - p.x;
    if (p.y < my) dy = my - p.y; else if (p.y > H - my) dy = H - my - p.y;
    if (dx || dy) { offX += dx; offY += dy; clampOffset(); applyTransform(); }
  }
  new ResizeObserver(layout).observe(stage);

  // ---------- input ----------
  const input = (kind, data = {}) => post('screen.input', { kind, ...data });
  const pointer = (kind, px, py, data = {}) => { const p = toRemote(px, py); if (p) input(kind, { ...p, ...data }); };

  const buzz = (style) => { if (window.PORTAL_APP) toApp({ type: 'haptic', style }); else if (navigator.vibrate) navigator.vibrate(style === 'medium' ? 15 : 8); };
  function ripple(x, y, right) {
    buzz('light');
    const r = h('div', { class: `scr-ripple${right ? ' right' : ''}` });
    r.style.left = `${x}px`; r.style.top = `${y}px`;
    stage.append(r);
    setTimeout(() => r.remove(), 450);
  }
  function clickAt(px, py, button, n) {
    if (trackpad) {
      input('click', { button, count: n });
      const p = toStage(cursor); if (p) ripple(p.x, p.y, button === 'right');
    } else {
      pointer('click', px, py, { button, count: n });
      ripple(px, py, button === 'right');
    }
  }

  // Trackpad: slow movements are precise, quick flicks cover distance
  function moveBy(dx, dy, speed) {
    const r = videoRect(); if (!r) return;
    const fast = Math.min(Math.max((speed - 150) / 1200, 0), 1);
    const gain = (0.6 + 2.4 * fast * fast) / zoom;
    input('moveBy', { dx: (dx * gain) / r.w, dy: (dy * gain) / r.h });
  }

  // Scrolls the Mac so its content moves with the finger (phone points → screen pixels)
  let scrollRest = { x: 0, y: 0 };
  function scroll(dx, dy) {
    const r = videoRect(); if (!r) return;
    const f = videoW / (r.w * zoom);
    scrollRest.x += dx * f; scrollRest.y += dy * f;
    const sx = Math.trunc(scrollRest.x), sy = Math.trunc(scrollRest.y);
    if (!sx && !sy) return;
    scrollRest.x -= sx; scrollRest.y -= sy;
    input('scroll', { dx: sx, dy: sy });
  }
  let momentum = null;
  function startMomentum(vx, vy) {
    stopMomentum();
    if (Math.hypot(vx, vy) < 150) return;
    let last = performance.now();
    const step = (now) => {
      const dt = (now - last) / 1000; last = now;
      scroll(vx * dt, vy * dt);
      const decay = Math.pow(0.135, dt); vx *= decay; vy *= decay; // the rate iOS scroll views slow down at
      momentum = Math.hypot(vx, vy) < 20 ? null : requestAnimationFrame(step);
    };
    momentum = requestAnimationFrame(step);
  }
  function stopMomentum() { if (momentum) cancelAnimationFrame(momentum); momentum = null; }

  // One gesture from first finger down to last finger up
  let g = null, lastTap = null;
  const pos = (t) => { const b = stage.getBoundingClientRect(); return { x: t.clientX - b.left, y: t.clientY - b.top }; };
  function centroid(ts) {
    const a = pos(ts[0]), b = pos(ts[1]);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  stage.addEventListener('touchstart', (e) => {
    if (e.target.closest('button,#scr-msg')) return;
    e.preventDefault();
    stopMomentum();
    const ts = e.touches;
    if (ts.length === 1 && !g) {
      const p = pos(ts[0]);
      g = { kind: 'one', start: p, last: p, t0: performance.now(), moved: false, pressed: false, dragging: false, vx: 0, vy: 0, lt: performance.now() };
      g.pressTimer = setTimeout(() => {
        if (!g || g.kind !== 'one' || g.moved) return;
        g.pressed = true;
        buzz('medium');
        if (!trackpad) pointer('move', g.start.x, g.start.y);
      }, 400);
    } else if (ts.length === 2) {
      if (g && g.pressTimer) clearTimeout(g.pressTimer);
      if (g && g.dragging) input('up', trackpad ? { button: 'left' } : { button: 'left', ...toRemote(g.last.x, g.last.y) });
      const c = centroid(ts);
      g = { kind: 'two', c0: c, last: c, t0: performance.now(), moved: false, pinching: false, zoom0: zoom, vx: 0, vy: 0, lt: performance.now() };
    }
  }, { passive: false });

  stage.addEventListener('touchmove', (e) => {
    if (!g) return;
    e.preventDefault();
    const now = performance.now();
    if (g.kind === 'one' && e.touches.length === 1) {
      const p = pos(e.touches[0]);
      const dx = p.x - g.last.x, dy = p.y - g.last.y;
      const dt = Math.max(1, now - g.lt);
      g.vx = 0.8 * (dx / dt) * 1000 + 0.2 * g.vx; g.vy = 0.8 * (dy / dt) * 1000 + 0.2 * g.vy; g.lt = now;
      if (!g.moved && Math.hypot(p.x - g.start.x, p.y - g.start.y) > 8) { g.moved = true; clearTimeout(g.pressTimer); }
      g.last = p;
      if (!g.moved) return;
      if (g.pressed) {
        // Hold, then drag: click-drag
        if (!g.dragging) {
          g.dragging = true;
          if (trackpad) input('down', { button: 'left' }); else pointer('down', g.start.x, g.start.y, { button: 'left' });
        }
        if (trackpad) moveBy(dx, dy, 0); else pointer('move', p.x, p.y);
      } else if (trackpad) {
        moveBy(dx, dy, Math.hypot(g.vx, g.vy));
      } else if (zoom > 1.01) {
        offX += dx; offY += dy; clampOffset(); applyTransform();
      } else {
        scroll(dx, dy);
      }
    } else if (g.kind === 'two' && e.touches.length >= 2) {
      const c = centroid(e.touches);
      const dx = c.x - g.last.x, dy = c.y - g.last.y;
      const dt = Math.max(1, now - g.lt);
      g.vx = 0.8 * (dx / dt) * 1000 + 0.2 * g.vx; g.vy = 0.8 * (dy / dt) * 1000 + 0.2 * g.vy; g.lt = now;
      if (!g.moved && (Math.hypot(c.x - g.c0.x, c.y - g.c0.y) > 10 || Math.abs(c.d / g.c0.d - 1) > 0.08)) g.moved = true;
      if (!g.pinching && Math.abs(c.d / g.c0.d - 1) > 0.12) g.pinching = true;
      if (g.pinching) {
        // Keep the content under the fingers in place while zooming, and follow the fingers as they move
        const nz = Math.min(5, Math.max(1, g.zoom0 * (c.d / g.c0.d)));
        const W = stage.clientWidth, H = stage.clientHeight;
        const ax = c.x - W / 2, ay = c.y - H / 2, ratio = nz / zoom;
        offX = ax - (ax - offX) * ratio + dx; offY = ay - (ay - offY) * ratio + dy;
        zoom = nz; clampOffset(); applyTransform();
      } else if (g.moved) {
        scroll(dx, dy);
      }
      g.last = c;
    }
  }, { passive: false });

  stage.addEventListener('touchend', (e) => {
    if (!g) return;
    e.preventDefault();
    if (e.touches.length) return; // wait for the last finger
    const done = g; g = null;
    clearTimeout(done.pressTimer);
    const quick = performance.now() - done.t0 < 350;
    if (done.kind === 'one') {
      if (done.dragging) {
        if (trackpad) input('up', { button: 'left' }); else pointer('up', done.last.x, done.last.y, { button: 'left' });
      } else if (done.pressed && !done.moved) {
        clickAt(done.start.x, done.start.y, 'right', 1);
      } else if (!done.moved && quick) {
        // Double and triple clicks: taps close together in time and place
        const now = performance.now();
        let n = 1, at = done.start;
        if (lastTap && now - lastTap.t < 400 && Math.hypot(at.x - lastTap.p.x, at.y - lastTap.p.y) < 30) { n = Math.min(3, lastTap.n + 1); at = lastTap.p; }
        lastTap = { t: now, p: at, n };
        clickAt(at.x, at.y, 'left', n);
      } else if (done.moved && !trackpad && zoom <= 1.01) {
        startMomentum(done.vx, done.vy);
      }
    } else if (done.kind === 'two') {
      if (!done.moved && quick) clickAt(done.c0.x, done.c0.y, 'right', 1);
      else if (done.pinching) {
        if (zoom < 1.05) { zoom = 1; offX = 0; offY = 0; applyTransform(); }
      } else if (done.moved) startMomentum(done.vx, done.vy);
    }
  }, { passive: false });
  stage.addEventListener('touchcancel', () => { if (g && g.dragging) input('up', { button: 'left' }); g = null; });

  // Mouse (desktop browsers): direct control
  stage.addEventListener('mousedown', (e) => { if (e.target === canvas || e.target === layer) { const p = pos(e); pointer('down', p.x, p.y, { button: ['left', 'middle', 'right'][e.button] || 'left', count: Math.min(3, e.detail || 1) }); kbd.focus({ preventScroll: true }); e.preventDefault(); } });
  stage.addEventListener('mouseup', (e) => { const p = pos(e); pointer('up', p.x, p.y, { button: ['left', 'middle', 'right'][e.button] || 'left', count: Math.min(3, e.detail || 1) }); });
  stage.addEventListener('mousemove', (e) => { if (e.buttons || e.target === canvas) { const p = pos(e); pointer('move', p.x, p.y); } });
  stage.addEventListener('wheel', (e) => { e.preventDefault(); scroll(-e.deltaX, -e.deltaY); }, { passive: false });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------- keyboard ----------
  // The hidden textarea always holds SENTINEL; what's added or removed is what was typed. That works with
  // the iOS keyboard, predictive text and dictation alike.
  const SENTINEL = '  ';
  let composing = false;
  function resetKbd() { kbd.value = SENTINEL; kbd.setSelectionRange(SENTINEL.length, SENTINEL.length); }
  resetKbd();
  function typeText(text) {
    if (sticky.size) {
      for (const ch of text) input('key', { key: ch === ' ' ? 'Space' : ch.toLowerCase(), modifiers: [...sticky, ...(ch !== ch.toLowerCase() ? ['shift'] : [])] });
      clearSticky();
      return;
    }
    let plain = '';
    const flush = () => { if (plain) input('text', { text: plain }); plain = ''; };
    for (const ch of text) {
      if (ch === '\n') { flush(); input('key', { key: 'Return', modifiers: [] }); } else plain += ch;
    }
    flush();
  }
  function key(name, mods = []) {
    input('key', { key: name, modifiers: [...new Set([...mods, ...sticky])] });
    clearSticky();
  }
  kbd.addEventListener('compositionstart', () => { composing = true; });
  kbd.addEventListener('compositionend', () => { composing = false; onKbdInput(); });
  kbd.addEventListener('input', () => { if (!composing) onKbdInput(); });
  function onKbdInput() {
    const v = kbd.value;
    if (v.length < SENTINEL.length && SENTINEL.startsWith(v)) {
      for (let i = v.length; i < SENTINEL.length; i++) key('Backspace');
    } else if (v.startsWith(SENTINEL)) {
      const added = v.slice(SENTINEL.length);
      if (added) typeText(added);
    } else {
      // The text was replaced (autocorrect): delete what was there, type the rest
      typeText(v.trimStart());
    }
    resetKbd();
  }
  // Hardware keyboards: arrows, Esc, Tab and shortcuts
  const NAMED = { Enter: 'Return', Tab: 'Tab', Escape: 'Escape', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Delete: 'Delete' };
  for (let i = 1; i <= 12; i++) NAMED['F' + i] = 'F' + i;
  // On a Windows or Linux keyboard, Ctrl works as ⌘ (so Ctrl+C copies) and the Windows key as Control
  const appleKeyboard = /Mac|iPhone|iPad/.test(navigator.platform) || (navigator.userAgentData && navigator.userAgentData.platform === 'macOS');
  kbd.addEventListener('keydown', (e) => {
    const mods = [];
    if (e.metaKey) mods.push(appleKeyboard ? 'command' : 'control');
    if (e.ctrlKey) mods.push(appleKeyboard ? 'control' : 'command');
    if (e.altKey) mods.push('alt');
    // Paste: let the browser fire a paste event, which sends this computer's clipboard first
    if (mods.length === 1 && mods[0] === 'command' && e.key.toLowerCase() === 'v') return;
    if (NAMED[e.key]) {
      if (e.shiftKey) mods.push('shift');
      key(NAMED[e.key], mods); e.preventDefault();
    } else if (mods.length && [...e.key].length === 1) {
      if (e.shiftKey) mods.push('shift');
      key(e.key.toLowerCase(), mods); e.preventDefault();
    }
  });
  kbd.addEventListener('paste', (e) => {
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    e.preventDefault();
    if (text) input('clipboard', { text });
    setTimeout(() => key('v', ['command']), 150);
  });
  kbd.addEventListener('focus', () => { document.body.classList.add('scr-typing'); $('#scr-kbd-btn').classList.remove('pulse'); });
  kbd.addEventListener('blur', () => { document.body.classList.remove('scr-typing'); clearSticky(); });

  // Special keys: modifiers stick until the next key, like the iOS shift key
  const KEYS = [
    ['esc', () => key('Escape')], ['tab', () => key('Tab')],
    ['⌘', 'command'], ['⌥', 'alt'], ['⌃', 'control'], ['⇧', 'shift'],
    ['←', () => key('Left')], ['↑', () => key('Up')], ['↓', () => key('Down')], ['→', () => key('Right')],
    ['⌘C', () => key('c', ['command'])], ['⌘V', () => key('v', ['command'])], ['⌘Z', () => key('z', ['command'])],
    ['⌘A', () => key('a', ['command'])], ['⌘S', () => key('s', ['command'])], ['⌘W', () => key('w', ['command'])],
    ['⌘Space', () => key('Space', ['command'])], ['⌫', () => key('Backspace')], ['⏎', () => key('Return')],
  ];
  const stickyButtons = new Map();
  function clearSticky() { sticky.clear(); for (const b of stickyButtons.values()) b.classList.remove('on'); }
  for (const [label, act] of KEYS) {
    const b = h('button', {}, label);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); // keep the keyboard open
      if (typeof act === 'string') { sticky.has(act) ? sticky.delete(act) : sticky.add(act); b.classList.toggle('on', sticky.has(act)); }
      else act();
    });
    if (typeof act === 'string') stickyButtons.set(act, b);
    $('#scr-keys').append(b);
  }

  // ---------- toolbar ----------
  function setMode(tp) {
    trackpad = tp;
    localStorage.setItem('vsp.trackpad', tp ? '1' : '0');
    $('#scr-mode').textContent = tp ? '🖱 Trackpad' : '👆 Touch';
    $('#scr-mode').classList.toggle('on', tp);
    updateRing();
  }
  setMode(trackpad);
  $('#scr-mode').onclick = () => { setMode(!trackpad); toast(trackpad ? 'Trackpad: drag to move the pointer, tap to click' : 'Touch: tap where you want to click'); };
  $('#scr-pick').onchange = (e) => {
    const screen = e.target.value === 'all' ? 'all' : Number(e.target.value);
    call('screen.config', { screen }).then(st => { status = st; zoom = 1; offX = offY = 0; applyTransform(); }).catch(err => toast(err.message));
  };
  $('#scr-kbd-btn').onclick = () => { if (document.activeElement === kbd) kbd.blur(); else { resetKbd(); kbd.focus({ preventScroll: true }); } };
  $('#scr-paste').onclick = async () => {
    try {
      const text = window.PORTAL_APP ? await askApp('clipboard.get') : await navigator.clipboard.readText();
      if (!text) return toast('The clipboard is empty');
      input('clipboard', { text });
      setTimeout(() => key('v', ['command']), 150);
    } catch { toast('Allow paste to send your clipboard to the Mac'); }
  };
  $('#scr-chat').onclick = () => {
    document.body.classList.add('chat-over');
    $('[data-view=prompt]').classList.remove('badge');
    updateCtx(); scrollChat(true);
  };
  $('#chat-grab').onclick = () => document.body.classList.remove('chat-over');
  const full = (on) => { document.body.classList.toggle('immersive', on); $('#scr-exit').hidden = !on; setTimeout(layout, 50); };
  $('#scr-full').onclick = () => full(true);
  $('#scr-exit').onclick = () => full(false);
  $('#scr-clip button').onclick = async () => {
    try { await navigator.clipboard.writeText(clipText || ''); toast('Copied to your phone'); } catch { toast('Couldn\'t copy'); }
    $('#scr-clip').hidden = true;
  };

  document.addEventListener('visibilitychange', () => {
    if (!active) return;
    if (document.hidden) leave(); else join();
  });

  return {
    onPacket,
    onReady(st) {
      status = st;
      joined = false;
      resetDecoder();
      if (active) join();
    },
    onEvent(m) {
      switch (m.event) {
        case 'capture':
          if (status) status = { ...status, capture: m, error: null };
          if (!videoW) message('Waiting for the screen…');
          break;
        case 'displays': if (status) { status = { ...status, displays: m.list }; renderPickers(status); } break;
        case 'permissions': if (status) { status = { ...status, screen: m.screen, accessibility: m.accessibility }; explain(status); } break;
        case 'error': if (status) status = { ...status, error: m.message }; message(m.message); break;
        case 'cursor': cursor = m; updateRing(); if (trackpad) keepCursorInView(); break;
        case 'stats': stats = m; renderStats(); break;
        case 'focus':
          macFocus = m.editable;
          // The app can open and close the keyboard by itself; a browser needs a tap, so the button pulses instead
          if (window.PORTAL_APP && autoKbd && active) {
            if (macFocus && document.activeElement !== kbd) { resetKbd(); kbd.focus({ preventScroll: true }); }
            else if (!macFocus && document.activeElement === kbd) kbd.blur();
          }
          $('#scr-kbd-btn').classList.toggle('pulse', macFocus && document.activeElement !== kbd);
          break;
        case 'clipboard':
          clipText = m.text;
          // In the app, a copy on the Mac lands on the phone's clipboard right away
          if (window.PORTAL_APP) { toApp({ type: 'clipboard.set', text: m.text }); toast('Copied from the Mac'); break; }
          $('#scr-clip span').textContent = `Copied on the Mac: ${m.text.slice(0, 40)}${m.text.length > 40 ? '…' : ''}`;
          $('#scr-clip').hidden = false;
          clearTimeout(this.clipTimer); this.clipTimer = setTimeout(() => { $('#scr-clip').hidden = true; }, 6000);
          break;
      }
    },
    show() { active = true; layout(); explain(status || (S.hello && S.hello.screen)); if (status && status.enabled) message('Connecting to the screen…'); join(); },
    hide() { active = false; kbd.blur(); full(false); leave(); },
  };
})();
