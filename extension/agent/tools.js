'use strict';
// The Mac agent's tools, served to Claude Code over MCP (see mcp.js). Same names and behavior as Portal's agent
// (~/Desktop/Portal/agent), so Claude uses the Mac the same way: computer use plus fast direct actions.
const { spawn } = require('child_process');
const os = require('os');
const { screenshot, run } = require('./mac');

const HOME = os.homedir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Terminal commands that always need the user's OK, even with auto-approve on (from Portal's agent)
const RISKY = [
  [/(^|[;&|(]\s*|\bxargs\s+|\bsudo\s+)rm\s+(-\w*[rRf]\w*|--recursive|--force|[^;&|]*\*)|\bfind\b.*\s-delete\b/i, 'deletes many files'],
  [/\b(sudo|su|doas)\b/i, 'runs as administrator'],
  [/\b(kill|pkill|killall)\b/i, 'stops running programs'],
  [/\blaunchctl\b/i, 'changes background services'],
  [/\b(shutdown|reboot|halt)\b|\bpmset\b.*\bsleep/i, 'shuts down or sleeps the Mac'],
  [/\bgit\s+push\b.*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)/i, 'force-pushes'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s|restore\s+\.|branch\s+-D|stash\s+(drop|clear))/i, 'throws away git changes'],
  [/\b(diskutil|mkfs|newfs|fdisk|dd)\b/i, 'can erase disks'],
  [/\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|python)/i, 'runs a script from the internet'],
  [/(^|[;&|]\s*)(\S*\/)?(mv|cp)\b.*\s\/(System|usr|bin|sbin|Library)\b/i, 'touches system folders'],
  [/(\.vscode-portal|\.ssh\b|\bkeychain\b|security\s+delete|Application Support\/Portal|portal-server)/i, 'touches Portal, keys or passwords'],
  [/\bosascript\b.*\b(quit|shut down|restart|log out)\b/i, 'quits apps or logs out'],
  [/:\(\)\s*\{/, 'fork bomb'],
  [/>\s*\/dev\/(disk|rdisk)/i, 'writes to a disk directly'],
];
const riskyReason = (command) => { for (const [re, why] of RISKY) if (re.test(command)) return why; return null; };

const SYSTEM = `You are an assistant that controls the user's Mac (macOS) and also answers questions directly.

- You can do anything the user could do at their keyboard. Pick the most direct, fastest route:
  - open_app / quit_app to launch or quit apps. If quitting brings up a "save changes?" dialog, ask the user.
  - open_path to open a folder in Finder or a file/folder in a specific app (e.g. app "Visual Studio Code").
    Use find_files first if you don't know where something is.
  - list_windows to see every window with its app, title and position (instant).
  - find_ui_elements + press_ui_element / set_ui_text to click buttons, menu items, tabs and links or fill in
    text fields by name, using accessibility. Prefer these over screenshot-and-click: they're faster and exact.
  - get_clipboard / set_clipboard for the Mac clipboard.
  - send_screenshot to show the user a picture in the chat, ONLY when they explicitly ask to see something. Never
    send one on your own, and not at the end of a task: just say in words what you did. When you do send one,
    crop to the relevant region so it's readable on a phone.
  - run_shell for anything faster done in Terminal. Risky commands (deleting, sudo, force-pushing, stopping
    programs...) wait for the user's approval; never try to work around that.
  - The computer tool (screenshot, click, type, key...) for everything else.
- The user is probably on their phone, away from the Mac. Your replies and send_screenshot are their only view.
- When waiting on something slow (a build, an upload, another AI assistant), use computer wait for 10-30 seconds
  between screenshots. Give up after about 10 minutes and report where things stand.
- The user's home folder is ${HOME}. "Desktop", "Downloads", "Documents" etc. live there.
- Take a screenshot when you need to see the screen, and after actions whose result you need to confirm.
- On macOS the Command key is "super" (e.g. "super+c" copies, "super+space" opens Spotlight).
- If the user just asks a question (e.g. solve these math problems from a picture), answer it directly.
- Before anything destructive or irreversible (deleting files, sending messages or email, purchases, changing
  passwords or system settings), stop and ask the user to confirm.
- Never quit or restart Visual Studio Code, Node, or anything named Portal: that's how the user reaches the Mac.
- You have a memory: your notes (below, if any) and search_chats for anything from earlier chats. When the user
  mentions something you don't recognize, search before asking them. Use remember for lasting facts.
- Keep replies short and friendly. When you finish a task, say what you did in one or two sentences.`;

const tool = (name, description, properties = {}, required) =>
  ({ name, description, inputSchema: { type: 'object', properties, required: required || Object.keys(properties) } });
const S = { type: 'string' };
const COMPUTER_ACTIONS = ['screenshot', 'zoom', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'left_click_drag', 'mouse_move', 'left_mouse_down', 'left_mouse_up', 'cursor_position', 'scroll', 'type', 'key', 'hold_key', 'wait'];
const NEEDS = { zoom: ['region'], left_click_drag: ['start_coordinate', 'coordinate'], mouse_move: ['coordinate'],
  scroll: ['scroll_direction'], type: ['text'], key: ['text'], hold_key: ['text', 'duration'], wait: ['duration'] };

const TOOLS = [
  {
    name: 'computer',
    description: 'Use the Mac\'s screen, mouse and keyboard. Coordinates are [x, y] pixels in the latest screenshot (its size '
      + 'is stated with it). Actions: screenshot; zoom (region [x0, y0, x1, y1] for a closer look); left_click / right_click / '
      + 'middle_click / double_click / triple_click (coordinate; optional text = modifier keys held, e.g. \'shift\'); '
      + 'left_click_drag (start_coordinate to coordinate); mouse_move (coordinate); left_mouse_down; left_mouse_up; '
      + 'cursor_position; scroll (coordinate, scroll_direction up/down/left/right, scroll_amount); type (text); key (text = a '
      + 'key or combo like \'super+c\', \'Return\', \'escape\'; optional repeat); hold_key (text, duration seconds); wait '
      + '(duration seconds, up to 30).',
    inputSchema: { type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: COMPUTER_ACTIONS },
      coordinate: { type: 'array', items: { type: 'number' }, description: '[x, y]' },
      start_coordinate: { type: 'array', items: { type: 'number' }, description: '[x, y] drag start' },
      region: { type: 'array', items: { type: 'number' }, description: '[x0, y0, x1, y1] for zoom' },
      text: S, scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, scroll_amount: { type: 'integer' },
      duration: { type: 'number' }, repeat: { type: 'integer' },
    } },
  },
  tool('open_app', 'Open (or bring to the front) a macOS app by name, e.g. \'Calculator\', \'Safari\'.', { name: { type: 'string', description: 'Application name' } }),
  tool('quit_app', 'Quit a running macOS app by name. Apps with unsaved work may show a save dialog instead.', { name: { type: 'string', description: 'Application name' } }),
  tool('hide_app', 'Hide a running app\'s windows.', { name: S }),
  tool('open_path', 'Open a folder or file. With app empty, folders open in Finder and files in their default app. Set app to open it '
    + 'in a specific application, e.g. \'Visual Studio Code\'. \'~\' is allowed.',
  { path: { type: 'string', description: 'Folder or file path' }, app: { type: 'string', description: 'Application to open it with, or empty string for default' } }),
  tool('open_url', 'Open a web address in the default browser.', { url: S }),
  tool('find_files', 'Search the Mac (Spotlight) for files or folders whose name contains the query. Up to 30 paths.',
    { query: { type: 'string', description: 'Part of the file or folder name' }, folders_only: { type: 'boolean', description: 'Only return folders' } }, ['query']),
  tool('list_windows', 'List every window: app, title, which monitor, and position in the current screenshot\'s coordinates '
    + '(when it\'s on the monitor you\'re looking at).'),
  tool('look_at', 'Change what screenshots show and return a new screenshot: \'front\' (the monitor with the front window, the '
    + 'default), \'all\' (every monitor side by side, smaller), or \'monitor 1\', \'monitor 2\'...', { target: S }),
  tool('window', 'Close, minimize, focus (bring to front) or toggle full screen for an app\'s window. title is part of the window '
    + 'title, or "" for its front window.', { app: S, title: S, action: { type: 'string', enum: ['close', 'minimize', 'focus', 'fullscreen'] } }),
  tool('find_ui_elements', 'Find buttons, menu items, fields, tabs, links etc. in an app by their label, using accessibility. '
    + 'Returns ids to use with press_ui_element / set_ui_text, and positions.',
  { app: { type: 'string', description: 'App name, or "" for the front app' }, text: { type: 'string', description: 'Part of the label to look for, or "" to list by role' },
    role: { type: 'string', description: 'button, menu item, text field, checkbox, tab, link... or ""' } }),
  tool('press_ui_element', 'Press (click) an element found by find_ui_elements.', { id: { type: 'integer' } }),
  tool('set_ui_text', 'Replace the text in a text field found by find_ui_elements.', { id: { type: 'integer' }, text: S }),
  tool('send_screenshot', 'Show the user a screenshot in the chat. region is [x0, y0, x1, y1] in screenshot coordinates to crop '
    + 'to, or [] for the whole view.', { caption: { type: 'string', description: 'Short caption' }, region: { type: 'array', items: { type: 'number' } } }),
  tool('get_clipboard', 'Read the text currently on the Mac clipboard.'),
  tool('set_clipboard', 'Put text on the Mac clipboard.', { text: S }),
  tool('set_volume', 'Set the volume (0-100), change it by an amount, or mute/unmute.',
    { level: { type: 'integer' }, change: { type: 'integer' }, muted: { type: 'boolean' } }, []),
  tool('change_brightness', 'Make the screen brighter or dimmer by a few steps.', { direction: { type: 'string', enum: ['up', 'down'] }, steps: { type: 'integer' } }, ['direction']),
  tool('media', 'Control music and video: play_pause, next, previous.', { control: { type: 'string', enum: ['play_pause', 'next', 'previous'] } }),
  tool('search_chats', 'Search all past chats with the user (what was asked, done and said). Use it when the user refers to '
    + 'something from before or you need context you don\'t have. Search with a few distinctive keywords.', { query: S }),
  tool('remember', 'Save one short, lasting fact to your notes, which you see at the start of every chat (e.g. where a project '
    + 'lives, a preference). Only for things worth knowing next time; not for one-off details.', { fact: S }),
  tool('run_shell', 'Run a zsh command on the Mac and get its output. Risky commands wait for the user\'s approval, so explain '
    + 'briefly in `reason` why it\'s needed.', { command: S, reason: { type: 'string', description: 'One short line shown when asking approval' } }),
];

// Claude's xdotool-style key names → the helper's
const KEY_NAMES = { return: 'return', enter: 'return', kp_enter: 'return', escape: 'escape', esc: 'escape', backspace: 'backspace',
  delete: 'delete', tab: 'tab', space: 'space', up: 'up', down: 'down', left: 'left', right: 'right', home: 'home', end: 'end',
  page_up: 'pageup', pageup: 'pageup', prior: 'pageup', page_down: 'pagedown', pagedown: 'pagedown', next: 'pagedown' };
const MOD_NAMES = { super: 'command', cmd: 'command', command: 'command', meta: 'command', ctrl: 'control', control: 'control',
  alt: 'alt', option: 'alt', opt: 'alt', shift: 'shift' };
function parseCombo(text) {
  const parts = String(text).split('+').map((p) => p.trim()).filter(Boolean);
  const modifiers = [], keys = [];
  for (const p of parts) { const m = MOD_NAMES[p.toLowerCase()]; if (m) modifiers.push(m); else keys.push(p); }
  let key = keys.pop() || '';
  const lower = key.toLowerCase();
  if (KEY_NAMES[lower]) key = KEY_NAMES[lower];
  else if (/^f\d{1,2}$/.test(lower)) key = lower;
  else if (key.length > 1) throw new Error(`Unknown key "${key}"`);
  return { key, modifiers };
}

// One mouse/keyboard user at a time: tasks running in parallel take turns
let guiQueue = Promise.resolve();
function withGui(fn) { const p = guiQueue.then(fn, fn); guiQueue = p.catch(() => {}); return p; }

/**
 * Tools for one chat's task. ctx: { mac, ui: { step(label), image(data, caption), approve(command, reason) → Promise<bool> },
 * settings: { autoApproveShell, showActions }, memory: { notes(), remember(fact), search(query) }, signal (AbortSignal) }
 */
function createTools(ctx) {
  const view = { target: 'front', rect: null, scale: 1, width: 0, height: 0 };
  const stopped = () => { if (ctx.signal && ctx.signal.aborted) throw new Error('Stopped by the user.'); };

  async function displays() { return ctx.mac.call('displays'); }
  // The rectangle (global points) screenshots show
  async function targetRect() {
    const list = await displays();
    const box = (ds) => { const x = Math.min(...ds.map((d) => d.x)), y = Math.min(...ds.map((d) => d.y));
      return { x, y, w: Math.max(...ds.map((d) => d.x + d.w)) - x, h: Math.max(...ds.map((d) => d.y + d.h)) - y }; };
    if (view.target === 'all') return box(list);
    const n = /monitor\s*(\d+)/i.exec(view.target);
    if (n) { const d = list[+n[1] - 1]; if (!d) throw new Error(`There's no monitor ${n[1]}; this Mac has ${list.length}.`); return box([d]); }
    // front: the monitor holding the front app's front window
    try {
      const front = await ctx.mac.call('frontmost');
      const win = (await ctx.mac.call('windows')).find((w) => w.pid === front.pid);
      if (win) {
        const cx = win.x + win.w / 2, cy = win.y + win.h / 2;
        const d = list.find((d) => cx >= d.x && cx < d.x + d.w && cy >= d.y && cy < d.y + d.h);
        if (d) return box([d]);
      }
    } catch {}
    return box([list.find((d) => d.main) || list[0]]);
  }
  async function shoot() {
    view.rect = await targetRect();
    const img = await screenshot(view.rect, view.target === 'all' ? 1800 : 1366);
    view.width = img.width; view.height = img.height; view.scale = img.width / view.rect.w;
    return img;
  }
  // Screenshot pixel → global point
  function toGlobal(c) {
    if (!view.rect) throw new Error('Take a screenshot first, so coordinates have something to refer to.');
    if (!Array.isArray(c) || c.length !== 2) throw new Error('coordinate must be [x, y]');
    return { x: view.rect.x + c[0] / view.scale, y: view.rect.y + c[1] / view.scale };
  }
  const imageResult = (img, note) => [{ type: 'image', data: img.data, mimeType: 'image/jpeg' }, { type: 'text', text: note }];
  const shotNote = () => `Screenshot is ${view.width}x${view.height}; coordinates are pixels of this image.`
    + (view.target !== 'front' ? ` (Showing: ${view.target}.)` : '');

  async function showAction(p) {
    if (!ctx.settings.showActions) return;
    try { await ctx.mac.call('mouse', { action: 'glide', ...p }); await ctx.mac.call('ripple', p, 3000); await sleep(120); } catch {}
  }

  async function computer(a) {
    const action = a.action;
    if (!COMPUTER_ACTIONS.includes(action)) throw new Error(`Unknown computer action: ${action}`);
    const missing = (NEEDS[action] || []).filter((k) => a[k] === undefined);
    if (missing.length) throw new Error(`${action} needs ${missing.join(', ')}`);
    const mods = a.text && /click/.test(action) ? parseCombo(`${a.text}+x`).modifiers : [];
    switch (action) {
      case 'screenshot': {
        const img = await shoot();
        ctx.ui.image(img.data, 'What I see', true);
        return imageResult(img, shotNote());
      }
      case 'zoom': {
        if (!view.rect) await shoot();
        const [x0, y0, x1, y1] = a.region;
        const g0 = toGlobal([x0, y0]), g1 = toGlobal([x1, y1]);
        const img = await screenshot({ x: g0.x, y: g0.y, w: Math.max(4, g1.x - g0.x), h: Math.max(4, g1.y - g0.y) }, 1366);
        return imageResult(img, 'Zoomed view (for reading only; click using screenshot coordinates).');
      }
      case 'left_click': case 'right_click': case 'middle_click': case 'double_click': case 'triple_click': {
        const p = a.coordinate ? toGlobal(a.coordinate) : await ctx.mac.call('cursor');
        await showAction(p);
        const button = action === 'right_click' ? 'right' : action === 'middle_click' ? 'middle' : 'left';
        const count = action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1;
        await ctx.mac.call('mouse', { action: 'click', ...p, button, count, modifiers: mods });
        return `Clicked at ${a.coordinate ? a.coordinate.join(', ') : 'the pointer'}.`;
      }
      case 'left_click_drag': {
        const p = toGlobal(a.start_coordinate), q = toGlobal(a.coordinate);
        await showAction(p);
        await ctx.mac.call('mouse', { action: 'drag', ...p, x2: q.x, y2: q.y });
        return 'Dragged.';
      }
      case 'mouse_move': await ctx.mac.call('mouse', { action: 'move', ...toGlobal(a.coordinate) }); return 'Moved the pointer.';
      case 'left_mouse_down': await ctx.mac.call('mouse', { action: 'down', ...(await ctx.mac.call('cursor')) }); return 'Mouse button down.';
      case 'left_mouse_up': await ctx.mac.call('mouse', { action: 'up', ...(await ctx.mac.call('cursor')) }); return 'Mouse button up.';
      case 'cursor_position': {
        const c = await ctx.mac.call('cursor');
        if (!view.rect) return `The pointer is at ${Math.round(c.x)}, ${Math.round(c.y)} (screen points).`;
        return `The pointer is at ${Math.round((c.x - view.rect.x) * view.scale)}, ${Math.round((c.y - view.rect.y) * view.scale)} in the screenshot.`;
      }
      case 'scroll': {
        const p = a.coordinate ? toGlobal(a.coordinate) : await ctx.mac.call('cursor');
        const n = Math.max(1, Math.min(30, a.scroll_amount || 3));
        const d = { up: [0, n], down: [0, -n], left: [n, 0], right: [-n, 0] }[a.scroll_direction];
        await ctx.mac.call('mouse', { action: 'scroll', ...p, dx: d[0], dy: d[1] });
        return `Scrolled ${a.scroll_direction}.`;
      }
      case 'type': await ctx.mac.call('type', { text: String(a.text) }, 60000); return `Typed ${String(a.text).length} characters.`;
      case 'key': {
        const { key, modifiers } = parseCombo(a.text);
        await ctx.mac.call('key', { key, modifiers, repeat: a.repeat || 1 });
        return `Pressed ${a.text}.`;
      }
      case 'hold_key': {
        const { key, modifiers } = parseCombo(a.text);
        await ctx.mac.call('key', { key, modifiers, repeat: Math.max(1, Math.round(Math.min(10, a.duration) * 10)) });
        return `Held ${a.text}.`;
      }
      case 'wait': await sleep(Math.min(30, Math.max(0, a.duration)) * 1000); return 'Waited.';
    }
    return 'Done.';
  }

  async function runShell({ command, reason }) {
    const risky = riskyReason(command);
    if (risky || !ctx.settings.autoApproveShell) {
      const ok = await ctx.ui.approve(command, risky ? `${reason || 'Run a command'} (⚠️ ${risky})` : (reason || 'Run a command'));
      if (!ok) throw new Error('The user declined to run this command.');
    }
    stopped();
    return new Promise((resolve) => {
      // stdin is /dev/null: a command waiting for input must never read anything of ours
      const p = spawn('/bin/zsh', ['-lc', command], { cwd: HOME, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
        env: { ...process.env, PORTAL_AGENT: '1', TERM: 'dumb', NO_COLOR: '1' } });
      let out = '';
      const add = (d) => { out = (out + d).slice(-20000); };
      p.stdout.on('data', add); p.stderr.on('data', add);
      const kill = () => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} };
      const timer = setTimeout(() => { add('\n(stopped after 2 minutes)'); kill(); }, 120000);
      const onAbort = () => { add('\n(stopped by the user)'); kill(); };
      if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });
      p.on('close', (code) => {
        clearTimeout(timer);
        if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
        resolve(`exit ${code}\n${out.trim() || '(no output)'}`);
      });
      p.on('error', (e) => { clearTimeout(timer); resolve(`Couldn't run it: ${e.message}`); });
    });
  }

  const LABELS = {
    open_app: (a) => `Opening ${a.name}`, quit_app: (a) => `Quitting ${a.name}`, hide_app: (a) => `Hiding ${a.name}`,
    open_path: (a) => `Opening ${a.path}${a.app ? ` in ${a.app}` : ''}`, open_url: (a) => `Opening ${a.url}`,
    find_files: (a) => `Looking for "${a.query}"`, list_windows: () => 'Listing windows', look_at: (a) => `Looking at ${a.target}`,
    window: (a) => `${a.action} ${a.app} window`, find_ui_elements: (a) => `Finding "${a.text || a.role}" in ${a.app || 'the front app'}`,
    press_ui_element: () => 'Pressing a button', set_ui_text: () => 'Filling in a field', send_screenshot: () => 'Taking a screenshot',
    get_clipboard: () => 'Reading the clipboard', set_clipboard: () => 'Setting the clipboard', set_volume: () => 'Changing the volume',
    change_brightness: (a) => `Brightness ${a.direction}`, media: (a) => a.control.replace('_', '/'),
    search_chats: (a) => `Searching past chats for "${a.query}"`, remember: () => 'Saving a note', run_shell: (a) => `$ ${a.command}`,
    computer: (a) => ({ screenshot: 'Looking at the screen', type: `Typing "${String(a.text || '').slice(0, 40)}"`, key: `Pressing ${a.text}`,
      wait: `Waiting ${a.duration}s`, scroll: `Scrolling ${a.scroll_direction}` })[a.action] || a.action.replace(/_/g, ' '),
  };
  // Tools that use the mouse, keyboard or screen take turns between parallel tasks
  const GUI = new Set(['computer', 'press_ui_element', 'set_ui_text', 'look_at', 'send_screenshot', 'window']);

  async function call(name, a = {}) {
    stopped();
    const label = (LABELS[name] || (() => name))(a);
    const go = async () => {
      stopped();
      ctx.ui.step(label);
      switch (name) {
        case 'computer': return computer(a);
        case 'open_app': return JSON.stringify(await ctx.mac.call('activate', { app: a.name }));
        case 'quit_app': {
          if (/visual studio code|^code$|portal|node/i.test(a.name)) throw new Error('Not quitting that: it\'s how the user reaches the Mac.');
          const r = await ctx.mac.call('quit', { app: a.name, wait: 3, protectPid: process.ppid }, 10000);
          return r.quit ? `Quit ${r.name}.` : r.running ? `${r.name} is still open (it may be asking to save).` : `${a.name} wasn't running.`;
        }
        case 'hide_app': await ctx.mac.call('hide', { app: a.name }); return `Hid ${a.name}.`;
        case 'open_path': return JSON.stringify(await ctx.mac.call('open', { target: a.path, app: a.app || '' }));
        case 'open_url': {
          if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(a.url)) a.url = `https://${a.url}`;
          return JSON.stringify(await ctx.mac.call('open', { target: a.url, app: '' }));
        }
        case 'find_files': {
          const q = String(a.query).replace(/["\\]/g, '');
          const expr = `kMDItemFSName == "*${q}*"c${a.folders_only ? ' && kMDItemContentType == "public.folder"' : ''}`;
          const out = await run('/usr/bin/mdfind', ['-onlyin', HOME, expr]).catch(() => '');
          const paths = out.split('\n').filter(Boolean).filter((p) => !/\/(Library|node_modules|\.git)\//.test(p)).slice(0, 30);
          return paths.length ? paths.join('\n') : 'Nothing found.';
        }
        case 'list_windows': {
          const wins = await ctx.mac.call('windows');
          const list = await displays();
          return JSON.stringify(wins.slice(0, 60).map((w) => {
            const mon = list.findIndex((d) => w.x + w.w / 2 >= d.x && w.x + w.w / 2 < d.x + d.w) + 1;
            const out = { app: w.app, title: w.title, monitor: mon || null };
            if (view.rect && w.x >= view.rect.x - 5 && w.x < view.rect.x + view.rect.w) {
              out.position = [Math.round((w.x - view.rect.x) * view.scale), Math.round((w.y - view.rect.y) * view.scale),
                Math.round(w.w * view.scale), Math.round(w.h * view.scale)];
            }
            return out;
          }));
        }
        case 'look_at': {
          const t = String(a.target || 'front').toLowerCase();
          if (!/^(front|all|monitor\s*\d+)$/.test(t)) throw new Error('target is front, all, or monitor N');
          view.target = t;
          const img = await shoot();
          ctx.ui.image(img.data, `Looking at ${t}`, true);
          return imageResult(img, shotNote());
        }
        case 'window': return JSON.stringify(await ctx.mac.call('window', { app: a.app, title: a.title || '', action: a.action }));
        case 'find_ui_elements': {
          const items = await ctx.mac.call('ax_find', { app: a.app || '', text: a.text || '', role: a.role || '', limit: 25, menus: true }, 20000);
          return JSON.stringify(items);
        }
        case 'press_ui_element': {
          try { const f = await ctx.mac.call('ax_frame', { element: a.id }); if (f.frame && f.frame.length === 4) await showAction({ x: f.frame[0] + f.frame[2] / 2, y: f.frame[1] + f.frame[3] / 2 }); } catch {}
          return JSON.stringify(await ctx.mac.call('ax_press', { element: a.id }));
        }
        case 'set_ui_text': return JSON.stringify(await ctx.mac.call('ax_set_value', { element: a.id, value: a.text }));
        case 'send_screenshot': {
          if (!view.rect) await shoot();
          let rect = view.rect;
          if (Array.isArray(a.region) && a.region.length === 4) {
            const g0 = toGlobal([a.region[0], a.region[1]]), g1 = toGlobal([a.region[2], a.region[3]]);
            rect = { x: g0.x, y: g0.y, w: Math.max(4, g1.x - g0.x), h: Math.max(4, g1.y - g0.y) };
          }
          const img = await screenshot(rect, 1600);
          ctx.ui.image(img.data, a.caption || 'Your screen');
          return 'Sent to the user.';
        }
        case 'get_clipboard': return (await ctx.mac.call('clipboard')).text || '(the clipboard is empty)';
        case 'set_clipboard': await ctx.mac.call('clipboard', { set: String(a.text) }); return 'Copied.';
        case 'set_volume': {
          const args = {};
          if (Number.isFinite(a.level)) args.level = a.level;
          if (Number.isFinite(a.change)) args.delta = a.change;
          if (typeof a.muted === 'boolean') args.muted = a.muted;
          const r = await ctx.mac.call('volume', args);
          if (r.level < 0) return 'This Mac\'s sound output (e.g. an HDMI monitor) doesn\'t let macOS change its volume.';
          return `Volume is ${r.level}%${r.muted ? ' (muted)' : ''}.`;
        }
        case 'change_brightness': {
          for (let i = 0; i < Math.max(1, Math.min(16, a.steps || 2)); i++) await ctx.mac.call('media', { key: `brightness_${a.direction}` });
          return `Brightness ${a.direction}.`;
        }
        case 'media': await ctx.mac.call('media', { key: a.control }); return `Pressed ${a.control.replace('_', '/')}.`;
        case 'search_chats': return ctx.memory.search(String(a.query || ''));
        case 'remember': ctx.memory.remember(String(a.fact || '')); return 'Saved to your notes.';
        case 'run_shell': return runShell(a);
        default: throw new Error(`Unknown tool: ${name}`);
      }
    };
    return GUI.has(name) ? withGui(go) : go();
  }

  return { call, list: () => TOOLS, view };
}

module.exports = { createTools, TOOLS, SYSTEM, riskyReason, parseCombo };
