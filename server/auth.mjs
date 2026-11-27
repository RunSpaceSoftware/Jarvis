// Protects the local HTTP API from other websites and other local origins.
//  - Host header must be a known local name (blocks DNS rebinding)
//  - Origin / Sec-Fetch-Site must be same-origin (blocks cross-site requests)
//  - A random token, delivered once via a console link and then kept in an
//    HttpOnly SameSite=Strict cookie, is required for everything but /api/health
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

const TOKEN_FILE = path.join(DATA_DIR, 'api_token.txt');
export const COOKIE_NAME = 'jarvis_token';

export function loadToken() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch {}
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
  return token;
}

function same(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function allowedHostSet(cfg, port) {
  const names = new Set(['127.0.0.1', 'localhost', '[::1]']);
  const bind = String(cfg.server?.host || '');
  if (bind && !['0.0.0.0', '::'].includes(bind)) names.add(bind.includes(':') ? '[' + bind.replace(/^\[|\]$/g, '') + ']' : bind.toLowerCase());
  for (const extra of cfg.server?.allowedHosts || []) names.add(String(extra).toLowerCase());
  const out = new Set();
  for (const n of names) out.add(n + ':' + port);
  return out;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function presentedToken(req) {
  const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return req.headers['x-jarvis-token'] || (bearer && bearer[1]) || parseCookies(req.headers.cookie)[COOKIE_NAME] || '';
}

export function tokenOk(req, token) {
  const given = presentedToken(req);
  return Boolean(given) && same(given, token);
}

export function linkTokenOk(value, token) {
  return Boolean(value) && same(value, token);
}

export function sessionCookie(token) {
  return COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000';
}

// Returns null if the request may proceed, or { status, error }.
export function originProblem(req, url, hosts) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!hosts.has(host)) return { status: 403, error: 'Forbidden host: ' + (host || '(none)') };
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let ok = false;
    try { ok = hosts.has(new URL(origin).host.toLowerCase()); } catch {}
    if (!ok) return { status: 403, error: 'Forbidden origin' };
  }
  if (url.pathname.startsWith('/api/')) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return { status: 403, error: 'Cross-site requests are not allowed' };
    const method = req.method || 'GET';
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
    if (['POST', 'PUT', 'PATCH'].includes(method) && hasBody && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      return { status: 415, error: 'Content-Type must be application/json' };
    }
  }
  return null;
}
