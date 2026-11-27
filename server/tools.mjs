import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SECRETS_DIR, ensureWorkspace } from './config.mjs';
import * as store from './store.mjs';
import { getSkill, listSkills } from './skills.mjs';
import { browserTool } from './browser.mjs';
import { googleTool } from './google.mjs';
import { readDocument } from './docs.mjs';
import { seeImage } from './vision.mjs';
import { githubTool } from './github.mjs';
import { gitTool } from './git.mjs';
import { httpTool } from './http.mjs';

const MAX_OUT = 20000;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'secrets', '.diag', 'dist', 'build', '__pycache__', '.venv']);

export function truncate(text, max = MAX_OUT) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max) + '\n...[truncated ' + (s.length - max) + ' chars]' : s;
}

function repeatLabel(sec) {
  if (sec >= 86400 && sec % 86400 === 0) return (sec / 86400) + 'd';
  if (sec >= 3600 && sec % 3600 === 0) return (sec / 3600) + 'h';
  return Math.round(sec / 60) + 'm';
}

function inside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function nearestExisting(p) {
  let cur = p;
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return cur;
}

function resolveSafe(p, cfg, forWrite = false) {
  if (!p || typeof p !== 'string') throw new Error('A path is required');
  const ws = ensureWorkspace(cfg);
  const realWs = fs.realpathSync(ws);
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(ws, p);
  if (!inside(ws, abs)) throw new Error('Path is outside the workspace: ' + p);
  const realTarget = fs.existsSync(abs) ? fs.realpathSync(abs) : fs.realpathSync(nearestExisting(abs));
  if (!inside(realWs, realTarget)) throw new Error('Path escapes the workspace through a link: ' + p);
  if (cfg.safety.blockSecrets && inside(fs.existsSync(SECRETS_DIR) ? fs.realpathSync(SECRETS_DIR) : SECRETS_DIR, realTarget)) {
    throw new Error('Access to secrets/ is blocked for the agent. Ask the user instead.');
  }
  const rel = path.relative(realWs, realTarget);
  if (forWrite && (rel === '.git' || rel.startsWith('.git' + path.sep))) throw new Error('Refusing to write into .git');
  return abs;
}

function globToRegExp(glob) {
  let out = '^';
  const s = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '*') {
      if (s[i + 1] === '*') { out += '.*'; i++; if (s[i + 1] === '/') i++; }
      else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if ('\\^$+()[]{}|.'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return new RegExp(out + '$', 'i');
}

function walkFiles(dir, out, limit, depth = 0) {
  if (out.length >= limit || depth > 14) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (entry.name.startsWith('.') && entry.name !== '.jarvis') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(full, out, limit, depth + 1);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '\"', '#39': "'", apos: "'", nbsp: ' ' };
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z#0-9]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

export function stripHtml(html) {
  return decodeEntities(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

async function fetchText(url, signal, timeoutMs = 25000) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.8'
    }
  });
  const text = await res.text();
  return { res, text };
}

async function webSearch(query, signal) {
  const q = encodeURIComponent(query);
  let html = '';
  let results = [];
  try {
    const lite = await fetchText('https://lite.duckduckgo.com/lite/?q=' + q, signal);
    html = lite.text;
    const anchors = [...html.matchAll(/<a\s+([^>]*class=['\"][^'\"]*result-link[^'\"]*['\"][^>]*)>([\s\S]*?)<\/a>/gi)];
    const snippets = [...html.matchAll(/<td[^>]*class=['\"][^'\"]*result-snippet[^'\"]*['\"][^>]*>([\s\S]*?)<\/td>/gi)]
      .map((m) => stripHtml(m[1]).replace(/\s+/g, ' ').trim());
    results = anchors.map((m, i) => {
      const hrefMatch = m[1].match(/href=['\"]([^'\"]+)['\"]/i);
      let href = hrefMatch ? decodeEntities(hrefMatch[1]) : '';
      const uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch {} }
      if (href.startsWith('//')) href = 'https:' + href;
      return { title: stripHtml(m[2]).trim(), url: href, snippet: snippets[i] || '' };
    }).filter((r) => r.title && /^https?:/.test(r.url));
  } catch {}
  if (!results.length) {
    try {
      const fallback = await fetchText('https://html.duckduckgo.com/html/?q=' + q, signal);
      const blocks = [...fallback.text.matchAll(/<a[^>]*class=['\"][^'\"]*result__a[^'\"]*['\"][^>]*href=['\"]([^'\"]+)['\"][^>]*>([\s\S]*?)<\/a>/gi)];
      results = blocks.map((m) => {
        let href = decodeEntities(m[1]);
        const uddg = href.match(/[?&]uddg=([^&]+)/);
        if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch {} }
        if (href.startsWith('//')) href = 'https:' + href;
        return { title: stripHtml(m[2]).trim(), url: href, snippet: '' };
      }).filter((r) => r.title && /^https?:/.test(r.url));
    } catch {}
  }
  if (!results.length) return 'No search results. The engine may be rate-limiting; try web_fetch on a known URL instead.';
  return results.slice(0, 8).map((r, i) => (i + 1) + '. ' + r.title + '\n   ' + r.url + (r.snippet ? '\n   ' + r.snippet : '')).join('\n');
}

export function parseCommandLine(input) {
  const s = String(input || '');
  if (!s.trim()) throw new Error('command is required');
  if (/[\0\r\n]/.test(s)) throw new Error('Newlines are not allowed in shell commands');
  const argv = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      has = true;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has) { argv.push(cur); cur = ''; has = false; }
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) throw new Error('Unclosed quote in shell command');
  if (has) argv.push(cur);
  if (!argv.length) throw new Error('command is required');
  return argv;
}

export function allowedCommands(cfg) {
  const raw = Array.isArray(cfg?.safety?.allowedCommands) ? cfg.safety.allowedCommands : [];
  return [...new Set(raw
    .map((s) => String(s || '').trim().toLowerCase().replace(/[.]((exe)|(cmd)|(bat)|(com))$/, ''))
    .filter((s) => /^[a-z0-9._-]{1,40}$/.test(s) && !s.startsWith('.')))];
}

function commandName(token) {
  const raw = String(token || '');
  if (!raw || /[\\/:]/.test(raw)) throw new Error('Use a bare program name, not a path: ' + raw);
  const name = raw.toLowerCase().replace(/[.]((exe)|(cmd)|(bat)|(com))$/, '');
  if (!/^[a-z0-9._-]{1,40}$/.test(name) || name.startsWith('.')) throw new Error('Invalid command name: ' + raw);
  return name;
}

function safeEnv() {
  const keep = new Set([
    'path', 'pathext', 'comspec', 'systemroot', 'systemdrive', 'windir', 'temp', 'tmp', 'tmpdir',
    'userprofile', 'homedrive', 'homepath', 'home', 'appdata', 'localappdata',
    'programfiles', 'programfiles(x86)', 'programdata', 'commonprogramfiles', 'commonprogramfiles(x86)',
    'number_of_processors', 'processor_architecture', 'os', 'username', 'userdomain', 'sessionname',
    'lang', 'lc_all', 'lc_ctype', 'term', 'user', 'logname', 'shell'
  ]);
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    if (keep.has(key.toLowerCase()) || /^LC_/i.test(key)) {
      env[process.platform === 'win32' ? key.toUpperCase() : key] = value;
    }
  }
  return env;
}

function resolveExecutable(token, env) {
  const isWin = process.platform === 'win32';
  const dirs = String(env.PATH || '').split(path.delimiter).map((s) => s.replace(/^"|"$/g, '')).filter((s) => s && path.isAbsolute(s));
  const exts = isWin ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const candidates = [];
  const hasExt = isWin ? /[.](exe|cmd|bat|com)$/i.test(token) : token.includes('.');
  if (hasExt) candidates.push(token);
  else for (const ext of exts) candidates.push(token + ext.toLowerCase());
  for (const dir of dirs) {
    for (const name of candidates) {
      const full = path.join(dir, name);
      try {
        if (!fs.statSync(full).isFile()) continue;
        if (!isWin) fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {}
    }
  }
  throw new Error('Command not found on PATH: ' + token);
}

function runShell(argv, timeoutSec, signal, cfg) {
  const isWin = process.platform === 'win32';
  const ws = ensureWorkspace(cfg);
  const env = safeEnv();
  const exe = resolveExecutable(argv[0], env);
  let file = exe;
  let args = argv.slice(1);
  if (isWin && /[.](cmd|bat)$/i.test(exe)) {
    for (const a of args) {
      if (/["&|<>^%\r\n]/.test(a)) throw new Error('This .cmd program cannot take quotes or shell operators in arguments');
    }
    file = env.COMSPEC || 'cmd.exe';
    const line = '"' + exe + '"' + (args.length ? ' ' + args.map((a) => '"' + a + '"').join(' ') : '');
    args = ['/d', '/s', '/c', '"' + line + '"'];
  }
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: ws, windowsHide: true, env, shell: false, detached: !isWin });
    const killTree = () => {
      if (!child.pid) return;
      if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, env });
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree();
      resolve({ code: null, timedOut: true, stdout: truncate(stdout, 12000), stderr: truncate(stderr, 4000) });
    }, Math.max(5, timeoutSec) * 1000);
    child.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > 400000) stdout = stdout.slice(-300000); });
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 100000) stderr = stderr.slice(-80000); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + '\n' + err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal?.aborted) killTree();
      resolve({ code, timedOut: false, stdout, stderr });
    });
    if (signal) signal.addEventListener('abort', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree();
      resolve({ code: null, aborted: true, stdout: truncate(stdout, 12000), stderr: truncate(stderr, 4000) });
    }, { once: true });
  });
}

const pathProp = { type: 'string', description: 'Path relative to the workspace (or absolute inside it)' };

export const TOOL_DEFS = [
  { type: 'function', function: { name: 'shell', description: 'Run an allowlisted program inside the workspace. There is no shell: pipes, redirection, && and $variables are not interpreted. Only program names in the Settings allowlist are accepted. Use for builds, tests, git and scripts.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Program and arguments, e.g. npm run build' }, timeoutSec: { type: 'number', description: 'Timeout in seconds (default 120)' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a text file. Use offset/limit for large files.', parameters: { type: 'object', properties: { path: pathProp, offset: { type: 'number' }, limit: { type: 'number', description: 'Max lines (default 400)' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or fully overwrite a text file. Creates parent directories.', parameters: { type: 'object', properties: { path: pathProp, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Replace one exact occurrence of old_string with new_string in a file. Fails if the old string is missing or ambiguous.', parameters: { type: 'object', properties: { path: pathProp, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'list_files', description: 'Find files whose path matches a glob such as **/*.ts. Returns up to 400 paths.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Glob pattern (default **/*)' } } } } },
  { type: 'function', function: { name: 'grep', description: 'Search file contents with a JavaScript regular expression. Returns matching lines with file and line number.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'File or folder (default workspace)' }, include: { type: 'string', description: 'Optional glob filter like *.js' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'web_fetch', description: 'Fetch an http(s) URL and return readable text (HTML is stripped). Use for research and reading docs.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'web_search', description: 'Search the web (DuckDuckGo) and return titles, URLs and snippets.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'remember', description: 'Save a durable fact, preference, decision or research finding to long-term memory. Use short self-contained statements.', parameters: { type: 'object', properties: { text: { type: 'string' }, kind: { type: 'string', description: 'fact | preference | decision | research' }, tags: { type: 'string', description: 'Comma separated tags' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'recall', description: 'Search long-term memory for relevant facts and past findings.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'goal_create', description: 'Create a persistent mission that Jarvis keeps working on autonomously across turns, including while the user is away. Use for multi-step or long-running work.', parameters: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string', description: 'Definition of done and constraints' } }, required: ['title'] } } },
  { type: 'function', function: { name: 'goal_list', description: 'List missions and their status/progress.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'goal_update', description: 'Update a mission: progress percent, status (active|paused|done), and a short note about the latest state. Call this when you make meaningful progress or finish.', parameters: { type: 'object', properties: { id: { type: 'number' }, progress: { type: 'number' }, status: { type: 'string' }, note: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'remind', description: 'Set a timed reminder. Use at (ISO 8601 with offset) or inMinutes. repeatSec makes it recur at a fixed interval (no weekday/calendar rules). Reminders notify the HUD, voice, and Telegram; they do not start a model turn.', parameters: { type: 'object', properties: { text: { type: 'string', description: 'What to remind the user about' }, at: { type: 'string', description: 'When, as ISO 8601 with offset, or epoch milliseconds' }, inMinutes: { type: 'number', description: 'Alternative to at: minutes from now' }, repeatSec: { type: 'number', description: 'Optional repeat interval in seconds (min 60; 86400 = daily)' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'reminder_list', description: 'List pending reminders with their due times and repeat intervals.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'reminder_cancel', description: 'Cancel a pending reminder by id.', parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'list_skills', description: 'List installed skills and their descriptions.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'use_skill', description: 'Load the full instructions of a skill before doing the matching kind of work.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'browser', description: 'Control a real Chrome/Edge window. Actions: open, snapshot, click, type, screenshot, close. Always snapshot after opening; click/type use refs from the latest snapshot.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['open', 'snapshot', 'click', 'type', 'screenshot', 'close'] }, url: { type: 'string', description: 'For open: full http(s) URL' }, ref: { type: 'string', description: 'Element ref from the latest snapshot' }, text: { type: 'string', description: 'For type' }, submit: { type: 'boolean', description: 'For type: submit the form or press Enter' } }, required: ['action'] } } },
  { type: 'function', function: { name: 'google', description: 'Read Gmail and Google Calendar, or send email/create events after explicit user approval. Actions: status, email_list, email_read, email_send, calendar_list, calendar_create. email_send and calendar_create require confirm=true only after the user says yes.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'email_list', 'email_read', 'email_send', 'calendar_list', 'calendar_create'] }, query: { type: 'string', description: 'Gmail search query, e.g. from:alice is:unread' }, max: { type: 'number' }, id: { type: 'string', description: 'Gmail message id' }, to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, from: { type: 'string', description: 'Calendar window start (ISO date or date-time)' }, toDate: { type: 'string', description: 'Calendar window end' }, summary: { type: 'string' }, start: { type: 'string', description: 'ISO 8601 with offset, e.g. 2026-05-01T10:00:00-04:00, or YYYY-MM-DD for all-day' }, end: { type: 'string', description: 'Same format as start; all-day end is exclusive' }, description: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['action'] } } },
  { type: 'function', function: { name: 'read_document', description: 'Extract text from a workspace document: PDF, DOCX, XLSX, PPTX, CSV, Markdown, HTML, JSON or plain text. Scanned PDFs may need OCR.', parameters: { type: 'object', properties: { path: pathProp }, required: ['path'] } } },
  { type: 'function', function: { name: 'see_image', description: 'Analyze a workspace image with the configured vision model. Use for screenshots, photos, charts, and reading visible text.', parameters: { type: 'object', properties: { path: pathProp, prompt: { type: 'string', description: 'What to look for' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'git', description: 'Read-only Git inspection in the workspace: status, diff, log, show. Does not commit or push.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'diff', 'log', 'show'] }, path: { type: 'string', description: 'Optional path for diff' }, staged: { type: 'boolean' }, max: { type: 'number' }, ref: { type: 'string', description: 'For show, default HEAD' } }, required: ['action'] } } },
  { type: 'function', function: { name: 'github', description: 'Call the GitHub REST API with the token in secrets/github_token.txt. Use GET freely; POST/PATCH/PUT/DELETE require confirm=true after explicit user approval.', parameters: { type: 'object', properties: { method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] }, path: { type: 'string', description: 'API path, e.g. /repos/owner/repo/issues' }, body: { description: 'JSON object or string' }, confirm: { type: 'boolean' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'http_request', description: 'Send an allowlisted HTTP request for APIs and webhooks. The hostname must be listed in integrations.http.allowedHosts. Use auth="name" to read a bearer token from secrets/http_name.txt.', parameters: { type: 'object', properties: { method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] }, url: { type: 'string' }, headers: { type: 'object' }, body: { description: 'String or JSON object' }, auth: { type: 'string', description: 'Secret name for a Bearer token' }, timeoutSec: { type: 'number' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'send_telegram', description: 'Send the user a Telegram message right now. Use for meaningful updates or when you need a decision.', parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } } },
  { type: 'function', function: { name: 'send_telegram_file', description: 'Send a workspace image or document to the paired Telegram chat. Use only when the user asks. JPEG, PNG and WebP images up to 10 MB are sent as photos; other files are sent as documents up to 50 MB.', parameters: { type: 'object', properties: { path: pathProp, caption: { type: 'string', description: 'Optional caption, up to 1024 characters' } }, required: ['path'] } } }
];

export async function executeTool(name, args, ctx) {
  const cfg = ctx.cfg;
  try {
    if (ctx.mcp?.has(name)) {
      const out = await ctx.mcp.call(name, args || {});
      return truncate(out);
    }
    switch (name) {
      case 'shell': {
        if (!cfg.safety.allowShell) throw new Error('Shell is disabled in Settings');
        if (!args?.command) throw new Error('command is required');
        const argv = parseCommandLine(args.command);
        const name = commandName(argv[0]);
        const allowed = allowedCommands(cfg);
        if (!allowed.includes(name)) {
          throw new Error('Command "' + name + '" is not allowed. Allowed: ' + (allowed.join(', ') || '(none — add commands in Settings)'));
        }
        const timeout = Math.min(900, Number(args.timeoutSec) || cfg.agent.shellTimeoutSec || 120);
        const r = await runShell(argv, timeout, ctx.signal, cfg);
        const parts = [];
        if (r.stdout) parts.push(r.stdout.trimEnd());
        if (r.stderr) parts.push('[stderr]\n' + r.stderr.trimEnd());
        if (r.timedOut) parts.push('[timed out after ' + timeout + 's]');
        if (r.aborted) parts.push('[aborted by user]');
        parts.push('[exit ' + (r.code ?? '?') + ']');
        return truncate(parts.join('\n'));
      }
      case 'read_file': {
        const abs = resolveSafe(args.path, cfg);
        if (!fs.existsSync(abs)) throw new Error('File not found: ' + args.path);
        const stat = fs.statSync(abs);
        if (stat.size > 2_000_000) throw new Error('File too large to read ( >2MB )');
        const lines = fs.readFileSync(abs, 'utf8').split('\n');
        const offset = Math.max(0, (Number(args.offset) || 1) - 1);
        const limit = Math.min(2000, Number(args.limit) || 400);
        const slice = lines.slice(offset, offset + limit);
        return truncate(slice.map((l, i) => String(offset + i + 1).padStart(5) + '  ' + l).join('\n') + (lines.length > offset + limit ? '\n...[more lines: ' + lines.length + ' total]' : ''));
      }
      case 'write_file': {
        const abs = resolveSafe(args.path, cfg, true);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(args.content ?? ''), 'utf8');
        return 'Wrote ' + Buffer.byteLength(String(args.content ?? '')) + ' bytes to ' + path.relative(ensureWorkspace(cfg), abs);
      }
      case 'edit_file': {
        const abs = resolveSafe(args.path, cfg, true);
        if (!fs.existsSync(abs)) throw new Error('File not found: ' + args.path);
        const text = fs.readFileSync(abs, 'utf8');
        const oldStr = String(args.old_string ?? '');
        if (!oldStr) throw new Error('old_string is required');
        const count = text.split(oldStr).length - 1;
        if (count === 0) throw new Error('old_string not found in ' + args.path);
        if (count > 1) throw new Error('old_string appears ' + count + ' times; make it unique');
        fs.writeFileSync(abs, text.replace(oldStr, String(args.new_string ?? '')), 'utf8');
        return 'Edited ' + path.relative(ensureWorkspace(cfg), abs);
      }
      case 'list_files': {
        const ws = ensureWorkspace(cfg);
        const files = [];
        walkFiles(ws, files, 2000);
        const re = globToRegExp(args.pattern || '**/*');
        const rel = files.map((f) => path.relative(ws, f).replace(/\\/g, '/')).filter((f) => re.test(f));
        return rel.length ? rel.slice(0, 400).join('\n') + (rel.length > 400 ? '\n...[+ ' + (rel.length - 400) + ' more]' : '') : 'No files matched ' + (args.pattern || '**/*');
      }
      case 'grep': {
        const pattern = String(args.pattern || '');
        if (!pattern) throw new Error('pattern is required');
        let re;
        try { re = new RegExp(pattern, 'i'); } catch (err) { throw new Error('Invalid regex: ' + err.message); }
        const base = args.path ? resolveSafe(args.path, cfg) : ensureWorkspace(cfg);
        const files = [];
        if (fs.existsSync(base) && fs.statSync(base).isFile()) files.push(base);
        else walkFiles(base, files, 4000);
        const include = args.include ? globToRegExp(args.include.includes('/') ? args.include : '**/' + args.include) : null;
        const hits = [];
        for (const file of files) {
          if (hits.length >= 120) break;
          const rel = path.relative(ensureWorkspace(cfg), file).replace(/\\/g, '/');
          if (include && !include.test(rel)) continue;
          let stat;
          try { stat = fs.statSync(file); } catch { continue; }
          if (stat.size > 800_000) continue;
          let text;
          try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
          if (text.includes('\u0000')) continue;
          const lines = text.split('\n');
          for (let i = 0; i < lines.length && hits.length < 120; i++) {
            if (re.test(lines[i])) hits.push(rel + ':' + (i + 1) + ': ' + lines[i].trim().slice(0, 240));
          }
        }
        return hits.length ? hits.join('\n') : 'No matches for ' + pattern;
      }
      case 'web_fetch': {
        const url = String(args.url || '');
        if (!/^https?:\/\//i.test(url)) throw new Error('A full http(s) URL is required');
        const { res, text } = await fetchText(url, ctx.signal, 30000);
        const type = res.headers.get('content-type') || '';
        const body = /json|text\/plain|xml/i.test(type) ? text : stripHtml(text);
        return truncate('[HTTP ' + res.status + '] ' + url + '\n\n' + body, 16000);
      }
      case 'web_search': {
        if (!args?.query) throw new Error('query is required');
        return truncate(await webSearch(args.query, ctx.signal), 12000);
      }
      case 'remember': {
        if (!args?.text) throw new Error('text is required');
        const id = store.addMemory(String(args.text), args.kind || 'fact', args.tags || '');
        ctx.emit?.('memory', { action: 'added', id });
        return 'Remembered (#' + id + ').';
      }
      case 'recall': {
        const rows = store.searchMemories(args?.query || '', 10);
        if (!rows.length) return 'Nothing in memory matches that.';
        store.touchMemories(rows.map((r) => r.id));
        return rows.map((r) => '#' + r.id + ' [' + r.kind + '] ' + r.text + (r.tags ? ' (' + r.tags + ')' : '')).join('\n');
      }
      case 'goal_create': {
        if (!args?.title) throw new Error('title is required');
        const goal = store.createGoal({ title: String(args.title), detail: String(args.detail || '') });
        ctx.onGoalCreated?.(goal);
        return 'Mission #' + goal.id + ' created and scheduled: ' + goal.title;
      }
      case 'goal_list': {
        const goals = store.listGoals();
        if (!goals.length) return 'No missions yet.';
        return goals.map((g) => '#' + g.id + ' [' + g.status + '] ' + g.progress + '% ' + g.title + (g.note ? '\n    note: ' + g.note : '')).join('\n');
      }
      case 'goal_update': {
        const id = Number(args?.id);
        if (!id) throw new Error('id is required');
        const patch = {};
        if (args.progress != null) patch.progress = Math.max(0, Math.min(100, Number(args.progress)));
        if (args.status) patch.status = String(args.status);
        if (args.note != null) patch.note = String(args.note);
        if (args.status === 'done') { patch.progress = 100; patch.next_wake = 0; }
        const updated = store.updateGoal(id, patch);
        if (!updated) throw new Error('Mission not found: ' + id);
        ctx.emit?.('goal', updated);
        return 'Mission #' + id + ' updated: ' + updated.status + ' ' + updated.progress + '%';
      }
      case 'remind': {
        const text = String(args?.text || '').trim().slice(0, 500);
        if (!text) throw new Error('text is required');
        let dueAt;
        if (args.inMinutes != null) {
          const mins = Number(args.inMinutes);
          if (!Number.isFinite(mins) || mins <= 0) throw new Error('inMinutes must be greater than zero');
          dueAt = Date.now() + Math.round(mins * 60000);
        } else if (args.at != null) {
          const raw = String(args.at).trim();
          const n = Number(raw);
          dueAt = /^\d+$/.test(raw) ? (n < 1e12 ? n * 1000 : n) : Date.parse(raw);
        } else {
          throw new Error('at or inMinutes is required');
        }
        if (!Number.isFinite(dueAt) || dueAt <= Date.now()) throw new Error('Reminder time must be in the future');
        const repeatSec = Math.floor(Number(args.repeatSec) || 0);
        if (repeatSec && (repeatSec < 60 || repeatSec > 31536000)) throw new Error('repeatSec must be 0, or between 60 and 31536000');
        const reminder = store.createReminder({ text, dueAt, repeatSec });
        const when = new Date(dueAt).toLocaleString();
        const repeated = repeatSec ? ' · repeats every ' + repeatLabel(repeatSec) : '';
        ctx.emit?.('reminder', { action: 'created', reminder, text: 'Reminder set for ' + when });
        return 'Reminder #' + reminder.id + ' set for ' + when + repeated + '.';
      }
      case 'reminder_list': {
        const rows = store.listReminders(50);
        if (!rows.length) return 'No pending reminders.';
        return rows.map((r) => '#' + r.id + ' · ' + new Date(r.due_at).toLocaleString() + ' · ' + r.text + (r.repeat_sec ? ' · every ' + repeatLabel(r.repeat_sec) : '')).join('\n');
      }
      case 'reminder_cancel': {
        const id = Number(args?.id);
        if (!Number.isInteger(id) || id <= 0) throw new Error('id is required');
        if (!store.cancelReminder(id)) throw new Error('Pending reminder not found: ' + id);
        ctx.emit?.('reminder', { action: 'cancelled', id, text: 'Reminder #' + id + ' cancelled' });
        return 'Reminder #' + id + ' cancelled.';
      }
      case 'list_skills': {
        const skills = listSkills();
        return skills.length ? skills.map((s) => '- ' + s.name + ': ' + s.description).join('\n') : 'No skills installed in skills/. Add <name>/SKILL.md.';
      }
      case 'use_skill': {
        const skill = getSkill(args?.name);
        if (!skill) return 'Skill not found: ' + args?.name + '. Available: ' + listSkills().map((s) => s.name).join(', ');
        return '# Skill: ' + skill.name + '\n\n' + skill.body;
      }
      case 'browser': {
        return truncate(await browserTool(args, cfg));
      }
      case 'google': {
        return truncate(await googleTool(args));
      }
      case 'read_document': {
        const abs = resolveSafe(args.path, cfg);
        if (!fs.existsSync(abs)) throw new Error('File not found: ' + args.path);
        if (fs.statSync(abs).size > 30_000_000) throw new Error('Document is larger than 30 MB');
        return truncate(await readDocument(abs));
      }
      case 'see_image': {
        const abs = resolveSafe(args.path, cfg);
        if (!fs.existsSync(abs)) throw new Error('File not found: ' + args.path);
        return truncate(await seeImage(abs, args.prompt, cfg, ctx.signal));
      }
      case 'git': {
        return truncate(await gitTool(args, cfg));
      }
      case 'github': {
        return truncate(await githubTool(args));
      }
      case 'http_request': {
        return truncate(await httpTool(args, cfg));
      }
      case 'send_telegram': {
        if (!ctx.telegram) throw new Error('Telegram bridge is not running');
        return await ctx.telegram.send(String(args?.message || ''));
      }
      case 'send_telegram_file': {
        if (!ctx.telegram) throw new Error('Telegram bridge is not running');
        if (!args?.path) throw new Error('path is required');
        const abs = resolveSafe(args.path, cfg);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('File not found: ' + args.path);
        return await ctx.telegram.sendFile(abs, { caption: args.caption });
      }
      default:
        throw new Error('Unknown tool: ' + name);
    }
  } catch (err) {
    if (err.name === 'AbortError') return 'Tool aborted by user.';
    return 'ERROR: ' + err.message;
  }
}
