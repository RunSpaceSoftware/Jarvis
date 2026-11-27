import { spawn } from 'node:child_process';
import { ROOT } from './config.mjs';

const PROTOCOL = '2024-11-05';

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms); })
  ]);
}

class StdioClient {
  constructor(name, conf) {
    this.name = name;
    this.conf = conf;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.tools = [];
  }

  async start() {
    const args = Array.isArray(this.conf.args) ? this.conf.args : [];
    this.proc = spawn(this.conf.command, args, {
      cwd: this.conf.cwd ? this.conf.cwd : ROOT,
      env: { ...process.env, ...(this.conf.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32'
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      const line = chunk.trim();
      if (line) this.conf.onLog?.(this.name, line.slice(0, 400));
    });
    this.proc.on('exit', (code) => this.onExit(code));
    await withTimeout(this.request('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: 'jarvis', version: '1.0.0' }
    }), 25000, 'MCP initialize');
    this.notify('notifications/initialized', {});
    const listed = await withTimeout(this.request('tools/list', {}), 20000, 'MCP tools/list');
    this.tools = listed.tools || [];
  }

  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this.onMessage(msg);
    }
  }

  onMessage(msg) {
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || 'MCP error'));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.id != null && msg.method) {
      // Server-initiated request we do not support; answer politely so it does not hang.
      this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Not supported by Jarvis' } });
    }
  }

  onExit(code) {
    for (const [, p] of this.pending) p.reject(new Error('MCP server ' + this.name + ' exited (' + code + ')'));
    this.pending.clear();
    this.conf.onExit?.(this.name, code);
  }

  write(obj) {
    if (!this.proc || this.proc.killed) throw new Error('MCP server ' + this.name + ' is not running');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    try { this.write({ jsonrpc: '2.0', id, method, params }); }
    catch (err) { this.pending.delete(id); return Promise.reject(err); }
    return withTimeout(p, timeoutMs, 'MCP ' + method);
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  async callTool(tool, args) {
    return this.request('tools/call', { name: tool, arguments: args || {} }, this.conf.timeoutMs || 120000);
  }

  close() {
    try { this.proc?.kill(); } catch {}
  }
}

class HttpClient {
  constructor(name, conf) {
    this.name = name;
    this.conf = conf;
    this.url = conf.url;
    this.sessionId = null;
    this.nextId = 1;
    this.tools = [];
  }

  headers() {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(this.conf.headers || {}) };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    return h;
  }

  async post(body) {
    const res = await fetch(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (!res.ok) throw new Error('MCP HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
    if (res.status === 202 || res.status === 204) return null;
    const text = await res.text();
    if (!text.trim()) return null;
    if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
      for (const block of text.split('\n\n')) {
        for (const line of block.split('\n')) {
          if (line.startsWith('data:')) {
            try { const msg = JSON.parse(line.slice(5).trim()); if (msg.id === body.id) return msg; } catch {}
          }
        }
      }
      return null;
    }
    return JSON.parse(text);
  }

  async request(method, params) {
    const id = this.nextId++;
    const msg = await withTimeout(this.post({ jsonrpc: '2.0', id, method, params }), 30000, 'MCP ' + method);
    if (!msg) throw new Error('MCP HTTP returned no response for ' + method);
    if (msg.error) throw new Error(msg.error.message || 'MCP error');
    return msg.result || {};
  }

  async start() {
    await this.request('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'jarvis', version: '1.0.0' }
    });
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    const listed = await this.request('tools/list', {});
    this.tools = listed.tools || [];
  }

  async callTool(tool, args) {
    return this.request('tools/call', { name: tool, arguments: args || {} });
  }

  close() {}
}

export class McpManager {
  constructor(cfg, emit) {
    this.cfg = cfg;
    this.emit = emit || (() => {});
    this.clients = new Map();
    this.status = new Map();
    this.toolMap = new Map();
  }

  confFor(name) {
    const raw = this.cfg.mcpServers?.[name];
    if (!raw) return null;
    return {
      ...raw,
      onLog: (n, line) => this.emit('log', { level: 'mcp', text: n + ': ' + line }),
      onExit: (n, code) => {
        this.status.set(n, { name: n, state: 'stopped', error: 'exited ' + code, tools: 0 });
        this.emit('mcp', this.list());
      }
    };
  }

  async startOne(name) {
    const conf = this.confFor(name);
    if (!conf) throw new Error('Unknown MCP server: ' + name);
    await this.stopOne(name);
    this.status.set(name, { name, state: 'starting', tools: 0 });
    this.emit('mcp', this.list());
    const client = conf.url ? new HttpClient(name, conf) : new StdioClient(name, conf);
    try {
      await client.start();
      this.clients.set(name, client);
      this.status.set(name, { name, state: 'ready', tools: (client.tools || []).length, transport: conf.url ? 'http' : 'stdio' });
      this.rebuildToolMap();
      this.emit('mcp', this.list());
      return client;
    } catch (err) {
      client.close();
      this.status.set(name, { name, state: 'error', tools: 0, error: err.message });
      this.emit('mcp', this.list());
      throw err;
    }
  }

  async stopOne(name) {
    const client = this.clients.get(name);
    if (client) { try { client.close(); } catch {} }
    this.clients.delete(name);
    this.status.set(name, { name, state: 'stopped', tools: 0 });
    this.rebuildToolMap();
  }

  async startAll() {
    for (const [name, conf] of Object.entries(this.cfg.mcpServers || {})) {
      if (conf.enabled === false) { this.status.set(name, { name, state: 'disabled', tools: 0 }); continue; }
      this.startOne(name).catch((err) => this.emit('log', { level: 'error', text: 'MCP ' + name + ': ' + err.message }));
    }
  }

  async restartAll() {
    for (const name of this.clients.keys()) await this.stopOne(name);
    await this.startAll();
  }

  async restartOne(name) {
    await this.startOne(name);
    return this.list().find((s) => s.name === name);
  }

  rebuildToolMap() {
    this.toolMap.clear();
    for (const [server, client] of this.clients) {
      for (const tool of client.tools || []) {
        const full = 'mcp__' + server + '__' + tool.name;
        this.toolMap.set(full, { server, tool: tool.name });
      }
    }
  }

  toolDefs() {
    const defs = [];
    for (const [server, client] of this.clients) {
      for (const tool of client.tools || []) {
        const full = 'mcp__' + server + '__' + tool.name;
        this.toolMap.set(full, { server, tool: tool.name });
        defs.push({
          type: 'function',
          function: {
            name: full,
            description: '[' + server + ' MCP] ' + (tool.description || tool.name).slice(0, 500),
            parameters: tool.inputSchema || { type: 'object', properties: {} }
          }
        });
      }
    }
    return defs;
  }

  has(fullName) { return this.toolMap.has(fullName); }

  async call(fullName, args) {
    const entry = this.toolMap.get(fullName);
    if (!entry) throw new Error('Unknown MCP tool: ' + fullName);
    const client = this.clients.get(entry.server);
    if (!client) throw new Error('MCP server not running: ' + entry.server);
    const result = await client.callTool(entry.tool, args);
    const content = result?.content || [];
    const text = content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image ' + (c.mimeType || '') + ']' : '[' + c.type + ']')).join('\n');
    if (result?.isError) throw new Error(text || 'MCP tool failed');
    return text || '(no output)';
  }

  list() {
    return Object.keys(this.cfg.mcpServers || {}).map((name) => this.status.get(name) || { name, state: 'idle', tools: 0 });
  }
}