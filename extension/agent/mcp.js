'use strict';
// Serves the Mac agent's tools to Claude Code over MCP (streamable HTTP, JSON replies). One secret path per running
// task, so a task's tool calls run with that chat's UI, approvals and Stop. Listens on 127.0.0.1 only.
const http = require('http');
const crypto = require('crypto');

const NAME = 'portal';

// A tool result as MCP content: text, or blocks with images
function content(result) {
  if (typeof result === 'string') return [{ type: 'text', text: result }];
  if (Array.isArray(result)) return result;
  return [{ type: 'text', text: JSON.stringify(result) }];
}

function createMcpServer() {
  const handlers = new Map(); // token -> { list(), call(name, args) }
  let server = null, port = 0;

  async function rpc(h, msg) {
    const { method, id } = msg;
    if (id === undefined || id === null) return null; // notifications need no answer
    const params = msg.params || {};
    let result;
    if (method === 'initialize') {
      result = { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } },
        serverInfo: { name: NAME, version: '1.0' } };
    } else if (method === 'ping') {
      result = {};
    } else if (method === 'tools/list') {
      result = { tools: h.list() };
    } else if (method === 'tools/call') {
      try {
        result = { content: content(await h.call(String(params.name || ''), params.arguments || {})), isError: false };
      } catch (e) {
        result = { content: content(e.message || String(e)), isError: true }; // the model sees the error and adapts
      }
    } else {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } };
    }
    return { jsonrpc: '2.0', id, result };
  }

  function start() {
    if (server) return Promise.resolve();
    server = http.createServer((req, res) => {
      const send = (status, body) => {
        const data = body === undefined ? '' : JSON.stringify(body);
        res.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json' });
        res.end(data);
      };
      const m = /^\/mcp\/([A-Za-z0-9_-]+)\/?$/.exec((req.url || '').split('?')[0]);
      const h = m && handlers.get(m[1]);
      if (req.method === 'DELETE') return send(h ? 200 : 404);
      if (req.method !== 'POST') return send(405);
      let raw = '';
      req.on('data', (d) => { raw += d; if (raw.length > 20e6) req.destroy(); });
      req.on('end', async () => {
        if (!h) return send(404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'No such task' } });
        let payload;
        try { payload = JSON.parse(raw || 'null'); } catch { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
        const msgs = Array.isArray(payload) ? payload : [payload];
        const replies = (await Promise.all(msgs.filter((x) => x && typeof x === 'object').map((x) => rpc(h, x)))).filter(Boolean);
        if (!replies.length) return send(202);
        send(200, Array.isArray(payload) ? replies : replies[0]);
      });
    });
    server.requestTimeout = 0; // approvals and long commands can take a while
    server.headersTimeout = 0;
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; server.unref(); resolve(); }));
  }

  return {
    // Serves tools for one task; returns the URL its Claude Code connects to
    async register(h) {
      await start();
      const token = crypto.randomBytes(24).toString('base64url');
      handlers.set(token, h);
      return { url: `http://127.0.0.1:${port}/mcp/${token}`, close: () => handlers.delete(token) };
    },
    close() { if (server) server.close(); server = null; handlers.clear(); },
  };
}

module.exports = { createMcpServer, NAME };
