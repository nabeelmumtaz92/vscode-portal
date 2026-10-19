#!/usr/bin/env node
// Free-AI proxy for Claude Code. Speaks Anthropic's Messages API on 127.0.0.1:8787 and answers from FREE providers
// (Gemini, Groq, OpenRouter, ...) so Claude Code keeps working when the Claude plan hits its limit.
//   Use:  ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_AUTH_TOKEN=free claude ...
// Keys come from ~/.config/free-ai/keys.env (KEY=value lines, chmod 600) or the environment. Each (provider, model) is
// a slot with its own free quota: calls rotate round-robin, and a slot that reports it is out of quota (429/402/403)
// rests 5 min, then 15, 45, 2 h, 6 h, 24 h and rejoins on its own. Nothing paid is ever called.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.FREE_AI_PORT || 8787);
const KEYS_FILE = path.join(os.homedir(), '.config', 'free-ai', 'keys.env');

const PROVIDERS = [
  { name: 'gemini', env: 'GEMINI_API_KEY', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', models: ['gemini-flash-latest', 'gemini-flash-lite-latest'] },
  { name: 'groq', env: 'GROQ_API_KEY', url: 'https://api.groq.com/openai/v1/chat/completions', models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'] },
  { name: 'openrouter', env: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/api/v1/chat/completions', models: ['openrouter/free'] },
  { name: 'cerebras', env: 'CEREBRAS_API_KEY', url: 'https://api.cerebras.ai/v1/chat/completions', models: ['qwen-3.8-27b'] },
  { name: 'sambanova', env: 'SAMBANOVA_API_KEY', url: 'https://api.sambanova.ai/v1/chat/completions', models: ['Meta-Llama-3.3-70B-Instruct'] },
  { name: 'huggingface', env: 'HF_TOKEN', url: 'https://router.huggingface.co/v1/chat/completions', models: ['openai/gpt-oss-120b'] },
  { name: 'nvidia', env: 'NVIDIA_API_KEY', url: 'https://integrate.api.nvidia.com/v1/chat/completions', models: ['meta/llama-3.3-70b-instruct'] },
  { name: 'mistral', env: 'MISTRAL_API_KEY', url: 'https://api.mistral.ai/v1/chat/completions', models: ['mistral-small-latest'] },
];

function loadKeys() {
  const keys = { ...process.env };
  try {
    for (const line of fs.readFileSync(KEYS_FILE, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[2]) keys[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no file: environment only */ }
  return keys;
}

// The Mac's own model (Ollama) is the unlimited floor: used after every free cloud slot that's ready, so it can't run out.
function localSlot(keys) {
  if (keys.LOCAL_AI_DISABLED === 'true') return null;
  return { id: `local:${keys.LOCAL_MODEL || 'qwen3:8b'}`, key: 'ollama', url: keys.LOCAL_AI_CHAT_URL || 'http://127.0.0.1:11434/v1/chat/completions', model: keys.LOCAL_MODEL || 'qwen3:8b', floor: true };
}

function slots() {
  const keys = loadKeys();
  const out = [];
  for (const p of PROVIDERS) {
    if (!keys[p.env]) continue;
    const override = keys[`AI_MODEL_${p.name.toUpperCase()}`];
    for (const model of override ? override.split(',').map((s) => s.trim()) : p.models) out.push({ id: `${p.name}:${model}`, key: keys[p.env], url: p.url, model });
  }
  const local = localSlot(keys);
  if (local) out.push(local);
  return out;
}

const resting = new Map(); // slot id -> { until, fails }
const REST_MIN = [5, 15, 45, 120, 360, 1440];
let rotation = 0;
let lastUsed = null;

function note(slot, status) {
  if (status === undefined) { resting.delete(slot.id); return; }
  const out = [401, 402, 403, 429].includes(status);
  const fails = (resting.get(slot.id)?.fails || 0) + (out ? 1 : 0);
  const rest = out ? REST_MIN[Math.min(Math.max(fails, 1) - 1, REST_MIN.length - 1)] * 60000 : 60000;
  resting.set(slot.id, { until: Date.now() + rest, fails });
  console.error(`[free-ai] ${slot.id} resting ${Math.round(rest / 60000)} min (${status || 'network'})`);
}

// ---------- Anthropic -> OpenAI chat ----------
const textOf = (c) => (typeof c === 'string' ? c : (c || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));

function toChat(req) {
  const messages = [];
  const sys = Array.isArray(req.system) ? req.system.map((b) => b.text).join('\n\n') : req.system;
  if (sys) messages.push({ role: 'system', content: sys });
  for (const m of req.messages || []) {
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      const text = textOf(m.content);
      messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      const parts = [];
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: textOf(b.content) || (b.is_error ? 'error' : 'ok') });
        } else if (b.type === 'text') parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image' && b.source?.type === 'base64') parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
      }
      if (parts.length) messages.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts });
    }
  }
  const body = { messages, max_tokens: Math.min(req.max_tokens || 4096, 16000), temperature: req.temperature ?? 0.3 };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } } }));
    body.tool_choice = req.tool_choice?.type === 'any' ? 'required' : req.tool_choice?.type === 'tool' ? { type: 'function', function: { name: req.tool_choice.name } } : 'auto';
  }
  return body;
}

async function callUpstream(req) {
  const all = slots();
  if (!all.length) throw Object.assign(new Error('No free AI keys configured in ~/.config/free-ai/keys.env'), { status: 503 });
  const cloud = all.filter((s) => !s.floor);
  const floor = all.filter((s) => s.floor);
  const start = cloud.length ? rotation++ % cloud.length : 0;
  const rotated = cloud.map((_, i) => cloud[(start + i) % cloud.length]);
  const now = Date.now();
  const ready = rotated.filter((s) => (resting.get(s.id)?.until || 0) <= now);
  const waiting = rotated.filter((s) => (resting.get(s.id)?.until || 0) > now).sort((a, b) => resting.get(a.id).until - resting.get(b.id).until);
  ready.push(...floor);
  const body = toChat(req);
  let lastErr;
  for (const slot of [...ready, ...waiting]) {
    try {
      const resp = await fetch(slot.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${slot.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, model: slot.model }),
        signal: AbortSignal.timeout(120000),
      });
      if (!resp.ok) { const t = await resp.text(); lastErr = new Error(`${slot.id} ${resp.status}: ${t.slice(0, 200)}`); note(slot, resp.status); continue; }
      const msg = (await resp.json()).choices?.[0]?.message;
      if (!msg || (!msg.content && !msg.tool_calls?.length)) { lastErr = new Error(`${slot.id} empty answer`); note(slot, 502); continue; }
      note(slot);
      lastUsed = slot.id;
      console.error(`[free-ai] answered by ${slot.id}`);
      return msg;
    } catch (e) { lastErr = e; note(slot, 0); }
  }
  throw lastErr || new Error('all free slots failed');
}

// ---------- OpenAI message -> Anthropic response ----------
function toAnthropic(msg, model) {
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* keep {} */ }
    content.push({ type: 'tool_use', id: tc.id || `toolu_${Math.random().toString(36).slice(2, 12)}`, name: tc.function.name, input });
  }
  return { id: `msg_${Math.random().toString(36).slice(2, 14)}`, type: 'message', role: 'assistant', model, content,
    stop_reason: content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
}

function streamAnthropic(res, m) {
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  send('message_start', { message: { ...m, content: [], stop_reason: null } });
  m.content.forEach((b, index) => {
    if (b.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
    } else {
      send('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    send('content_block_stop', { index });
  });
  send('message_delta', { delta: { stop_reason: m.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } });
  send('message_stop', {});
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && url === '/health') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: true, slots: slots().map((s) => s.id), resting: [...resting].map(([id, v]) => ({ id, minutes: Math.max(0, Math.round((v.until - Date.now()) / 60000)) })), lastUsed }));
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    try {
      const body = raw ? JSON.parse(raw) : {};
      if (url === '/v1/messages/count_tokens') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ input_tokens: Math.ceil(raw.length / 4) })); }
      if (url === '/v1/messages' && req.method === 'POST') {
        const msg = await callUpstream(body);
        const out = toAnthropic(msg, body.model || 'free');
        if (body.stream) return streamAnthropic(res, out);
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify(out));
      }
      res.statusCode = 404; res.end('{"error":"not found"}');
    } catch (e) {
      res.statusCode = e.status && e.status >= 400 ? e.status : 529; // 529 = overloaded: Claude Code retries then reports it
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: String(e.message || e) } }));
    }
  });
});
server.listen(PORT, '127.0.0.1', () => console.error(`[free-ai] proxy on http://127.0.0.1:${PORT} with ${slots().length} free slots`));
