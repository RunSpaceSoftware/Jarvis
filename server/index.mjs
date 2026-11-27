import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, publicConfig, ensureWorkspace, workspaceDir, CONFIG_PATH, SECRETS_DIR } from './config.mjs';
import * as store from './store.mjs';
import { Agent, bus } from './agent.mjs';
import { Telegram } from './telegram.mjs';
import { listSkills, loadSkills, getSkill } from './skills.mjs';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const cfg = loadConfig();
if (!fs.existsSync(CONFIG_PATH)) saveConfig(cfg);

const agent = new Agent(cfg);
const telegram = new Telegram(cfg, agent);
agent.telegram = telegram;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json'
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4_000_000) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sanitiseSafety(raw) {
  const patch = { ...(raw || {}) };
  if (patch.workspace !== undefined) {
    const value = String(patch.workspace || '').trim();
    if (!value) throw new Error('Workspace path is required');
    if (value.length > 500 || value.includes('\0')) throw new Error('Invalid workspace path');
    try {
      patch.workspace = ensureWorkspace({ safety: { workspace: value } });
    } catch (err) {
      throw new Error('Workspace is not usable: ' + err.message);
    }
  }
  if (patch.allowedCommands !== undefined) {
    const list = Array.isArray(patch.allowedCommands)
      ? patch.allowedCommands
      : String(patch.allowedCommands || '').split(/[\s,]+/);
    const commands = [...new Set(list
      .map((s) => String(s || '').trim().toLowerCase().replace(/[.]((exe)|(cmd)|(bat)|(com))$/, ''))
      .filter(Boolean))];
    for (const c of commands) {
      if (!/^[a-z0-9._-]{1,40}$/.test(c) || c.startsWith('.')) throw new Error('Invalid command name: ' + c);
    }
    if (commands.length > 50) throw new Error('Too many allowed commands (max 50)');
    patch.allowedCommands = commands;
  }
  const truthy = (v) => v === true || v === 1 || v === 'true' || v === '1';
  if (patch.allowShell !== undefined) patch.allowShell = truthy(patch.allowShell);
  if (patch.blockSecrets !== undefined) patch.blockSecrets = truthy(patch.blockSecrets);
  return patch;
}

function visibleMessages() {
  return store.listMessages(agent.sessionId, 400).filter((m) => !m.hidden && m.role !== 'tool');
}

function bootstrap() {
  return {
    ok: true,
    config: publicConfig(cfg),
    state: agent.snapshot(),
    messages: visibleMessages(),
    sessions: store.listSessions(),
    memories: store.listMemories(80),
    events: store.listEvents(80),
    stats: store.stats(),
    now: Date.now()
  };
}

function mergeDeep(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) mergeDeep(base[k], v);
    else if (v !== undefined) base[k] = v;
  }
  return base;
}

async function api(req, res, url) {
  const method = req.method || 'GET';
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, uptime: process.uptime() });
  if (url.pathname === '/api/bootstrap' && method === 'GET') return sendJson(res, 200, bootstrap());
  if (url.pathname === '/api/events' && method === 'GET') return events(req, res);

  if (url.pathname === '/api/chat' && method === 'POST') {
    const body = await readJson(req);
    const text = String(body.text || '').trim();
    if (!text) return sendJson(res, 400, { ok: false, error: 'text is required' });
    if (/^\/(stop|pause)$/i.test(text)) {
      agent.stopCurrent('Stopped from the interface');
      return sendJson(res, 200, { ok: true, stopped: true });
    }
    const item = agent.enqueue(text, 'ui');
    return sendJson(res, 202, { ok: true, id: item?.id, configured: cfg.model.configured });
  }
  if (url.pathname === '/api/stop' && method === 'POST') {
    agent.stopCurrent('Stopped from the interface');
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/api/session/new' && method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const id = agent.newSession(body.title || 'New thread');
    return sendJson(res, 200, { ok: true, id, messages: visibleMessages() });
  }
  if (url.pathname === '/api/session/switch' && method === 'POST') {
    const body = await readJson(req);
    agent.switchSession(Number(body.id));
    return sendJson(res, 200, { ok: true, id: agent.sessionId, messages: visibleMessages() });
  }

  if (url.pathname === '/api/goals' && method === 'GET') return sendJson(res, 200, { ok: true, goals: store.listGoals(50), runs: store.listRuns(null, 20) });
  if (url.pathname === '/api/goals' && method === 'POST') {
    const body = await readJson(req);
    const title = String(body.title || '').trim();
    if (!title) return sendJson(res, 400, { ok: false, error: 'title is required' });
    const goal = store.createGoal({ title, detail: String(body.detail || '') });
    store.updateGoal(goal.id, { next_wake: Date.now() });
    agent.emit('goal', store.getGoal(goal.id));
    agent.emit('state', agent.snapshot());
    if (cfg.agent.autopilot) agent.pump().catch((e) => agent.emit('log', { level: 'error', text: e.message }));
    return sendJson(res, 200, { ok: true, goal: store.getGoal(goal.id) });
  }
  if (parts[0] === 'api' && parts[1] === 'goals' && parts[2] && (method === 'PATCH' || method === 'POST')) {
    const body = await readJson(req);
    const id = Number(parts[2]);
    const patch = {};
    if (body.status) { patch.status = String(body.status); patch.next_wake = body.status === 'active' ? Date.now() : 0; }
    if (body.progress != null) patch.progress = Math.max(0, Math.min(100, Number(body.progress)));
    if (body.note != null) patch.note = String(body.note);
    if (body.title) patch.title = String(body.title);
    if (body.detail != null) patch.detail = String(body.detail);
    const goal = store.updateGoal(id, patch);
    if (!goal) return sendJson(res, 404, { ok: false, error: 'Mission not found' });
    store.addEvent('goal', 'Mission #' + id + ' → ' + goal.status);
    agent.emit('goal', goal);
    agent.emit('state', agent.snapshot());
    if (goal.status === 'active' && cfg.agent.autopilot) agent.pump().catch(() => {});
    return sendJson(res, 200, { ok: true, goal });
  }
  if (parts[0] === 'api' && parts[1] === 'goals' && parts[2] && method === 'DELETE') {
    store.deleteGoal(Number(parts[2]));
    agent.emit('state', agent.snapshot());
    return sendJson(res, 200, { ok: true });
  }
  if (parts[0] === 'api' && parts[1] === 'reminders' && parts[2] && method === 'DELETE') {
    const id = Number(parts[2]);
    if (!id || !store.cancelReminder(id)) return sendJson(res, 404, { ok: false, error: 'Pending reminder not found' });
    agent.emit('reminder', { action: 'cancelled', id, text: 'Reminder #' + id + ' cancelled' });
    agent.emit('state', agent.snapshot());
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/api/memories' && method === 'GET') {
    const q = url.searchParams.get('q');
    return sendJson(res, 200, { ok: true, memories: q ? store.searchMemories(q, 50) : store.listMemories(200) });
  }
  if (url.pathname === '/api/memories' && method === 'POST') {
    const body = await readJson(req);
    const text = String(body.text || '').trim();
    if (!text) return sendJson(res, 400, { ok: false, error: 'text is required' });
    const id = store.addMemory(text, String(body.kind || 'fact'), String(body.tags || ''));
    return sendJson(res, 200, { ok: true, id });
  }
  if (parts[0] === 'api' && parts[1] === 'memories' && parts[2] && method === 'DELETE') {
    store.deleteMemory(Number(parts[2]));
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/api/skills' && method === 'GET') return sendJson(res, 200, { ok: true, skills: listSkills() });
  if (url.pathname === '/api/skills/reload' && method === 'POST') {
    loadSkills();
    agent.emit('state', agent.snapshot());
    return sendJson(res, 200, { ok: true, skills: listSkills().map((s) => ({ name: s.name, description: s.description })) });
  }
  if (parts[0] === 'api' && parts[1] === 'skills' && parts[2] && method === 'GET') {
    const skill = getSkill(decodeURIComponent(parts[2]));
    return skill ? sendJson(res, 200, { ok: true, skill }) : sendJson(res, 404, { ok: false, error: 'Skill not found' });
  }

  if (url.pathname === '/api/mcp' && method === 'GET') return sendJson(res, 200, { ok: true, servers: agent.mcp.list() });
  if (url.pathname === '/api/mcp' && method === 'POST') {
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name)) return sendJson(res, 400, { ok: false, error: 'name must be 1-40 chars: letters, numbers, _ or -' });
    let args = body.args;
    if (typeof args === 'string') args = args.trim() ? args.trim().split(/\s+/) : [];
    if (!Array.isArray(args)) args = [];
    if (!body.url && !body.command) return sendJson(res, 400, { ok: false, error: 'command or url is required' });
    cfg.mcpServers[name] = body.url
      ? { url: String(body.url), headers: body.headers || {}, enabled: true }
      : { command: String(body.command), args, env: body.env || {}, enabled: true };
    saveConfig(cfg);
    try { await agent.mcp.startOne(name); } catch (err) {
      agent.emit('state', agent.snapshot());
      return sendJson(res, 200, { ok: false, error: err.message, servers: agent.mcp.list() });
    }
    agent.emit('state', agent.snapshot());
    return sendJson(res, 200, { ok: true, servers: agent.mcp.list() });
  }
  if (parts[0] === 'api' && parts[1] === 'mcp' && parts[2] && method === 'DELETE') {
    const name = decodeURIComponent(parts[2]);
    await agent.mcp.stopOne(name);
    delete cfg.mcpServers[name];
    saveConfig(cfg);
    agent.emit('state', agent.snapshot());
    return sendJson(res, 200, { ok: true, servers: agent.mcp.list() });
  }
  if (parts[0] === 'api' && parts[1] === 'mcp' && parts[2] && parts[3] === 'restart' && method === 'POST') {
    try { await agent.mcp.restartOne(decodeURIComponent(parts[2])); } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message, servers: agent.mcp.list() });
    }
    agent.emit('state', agent.snapshot());
    return sendJson(res, 200, { ok: true, servers: agent.mcp.list() });
  }

  if (url.pathname === '/api/config' && method === 'GET') return sendJson(res, 200, { ok: true, config: publicConfig(cfg) });
  if (url.pathname === '/api/config' && method === 'POST') {
    const body = await readJson(req);
    const patch = {};
    for (const key of ['name', 'user', 'model', 'agent', 'telegram', 'voice', 'safety']) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (patch.safety) {
      try { patch.safety = sanitiseSafety(patch.safety); }
      catch (err) { return sendJson(res, 400, { ok: false, error: err.message }); }
    }
    mergeDeep(cfg, patch);
    saveConfig(cfg);
    if (cfg.agent.autopilot) { agent.scheduleWake(); agent.pump().catch(() => {}); }
    if (body.telegram) telegram.restart().catch(() => {});
    agent.emit('state', agent.snapshot());
    return sendJson(res, 200, { ok: true, config: publicConfig(cfg) });
  }
  if (url.pathname === '/api/secrets' && method === 'POST') {
    const body = await readJson(req);
    const writes = [
      ['modelKey', 'model_key.txt'],
      ['telegramToken', 'telegram_token.txt'],
      ['discordToken', 'discord_token.txt']
    ];
    const written = [];
    for (const [field, file] of writes) {
      const value = String(body[field] || '').trim();
      if (!value) continue;
      if (value.length < 8) return sendJson(res, 400, { ok: false, error: field + ' looks too short' });
      fs.mkdirSync(SECRETS_DIR, { recursive: true });
      fs.writeFileSync(path.join(SECRETS_DIR, file), value + '\n', { mode: 0o600 });
      written.push(field);
    }
    if (written.includes('telegramToken')) telegram.restart().catch(() => {});
    agent.emit('state', agent.snapshot());
    return sendJson(res, 200, { ok: true, written, config: publicConfig(cfg) });
  }
  if (url.pathname === '/api/telegram/test' && method === 'POST') {
    try {
      const result = await telegram.send('✅ Jarvis Telegram bridge is working. Reply here to talk to me.');
      return sendJson(res, 200, { ok: true, result });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message });
    }
  }

  if (url.pathname === '/api/events/history' && method === 'GET') return sendJson(res, 200, { ok: true, events: store.listEvents(200) });

  return sendJson(res, 404, { ok: false, error: 'Unknown API route' });
}

function events(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 2000\n\n');
  const onEvent = (event) => {
    try { res.write('data: ' + JSON.stringify(event) + '\n\n'); } catch {}
  };
  bus.on('event', onEvent);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
  const cleanup = () => { clearInterval(ping); bus.off('event', onEvent); };
  req.on('close', cleanup);
  res.on('close', cleanup);
  onEvent({ type: 'state', at: Date.now(), ...agent.snapshot() });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(WEB_DIR, path.normalize(rel).replace(/^([.][.][\/\\])+/, ''));
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return sendText(res, 404, 'Not found');
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    console.error('[http]', err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message });
    else res.end();
  }
});

agent.start();
telegram.start();

const port = Number(cfg.server.port) || 8787;
const host = cfg.server.host || '127.0.0.1';
server.listen(port, host, () => {
  console.log('');
  console.log('  JARVIS  ·  http://' + host + ':' + port);
  console.log('  workspace: ' + workspaceDir(cfg));
  console.log('  model: ' + cfg.model.model + ' @ ' + cfg.model.baseUrl + (publicConfig(cfg).model.configured ? '' : '  (no API key yet)'));
  console.log('  telegram: ' + telegram.status().state + (cfg.telegram.chatId ? ' · paired' : ' · not paired'));
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\nShutting down...');
    agent.stop();
    telegram.stop().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
