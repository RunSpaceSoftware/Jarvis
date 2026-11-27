import fs from 'node:fs';
import path from 'node:path';
import { SECRETS_DIR } from './config.mjs';

function allowed(host, cfg) {
  const list = cfg.integrations?.http?.allowedHosts || [];
  const h = String(host || '').toLowerCase();
  return list.some((rule) => {
    const r = String(rule || '').toLowerCase().trim();
    return r.startsWith('*.') ? h.endsWith(r.slice(1)) : h === r;
  });
}

function secret(name) {
  if (!/^[a-z0-9_-]{1,40}$/i.test(String(name || ''))) throw new Error('Invalid auth name');
  const file = path.join(SECRETS_DIR, 'http_' + name + '.txt');
  if (!fs.existsSync(file)) throw new Error('Missing ' + path.relative(path.resolve(SECRETS_DIR, '..'), file));
  const value = fs.readFileSync(file, 'utf8').trim();
  if (!value) throw new Error('Empty auth secret');
  return value;
}

export async function httpTool(args = {}, cfg) {
  const method = String(args.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) throw new Error('Unsupported method');
  let url;
  try { url = new URL(String(args.url || '')); } catch { throw new Error('A full http(s) URL is required'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http(s) URLs are allowed');
  if (url.username || url.password) throw new Error('Credentials in URLs are not allowed; use auth');
  if (!allowed(url.hostname, cfg)) {
    throw new Error('Host ' + url.hostname + ' is not allowlisted. Add it to integrations.http.allowedHosts in config/config.json.');
  }
  const headers = { ...(args.headers && typeof args.headers === 'object' ? args.headers : {}) };
  for (const key of Object.keys(headers)) {
    if (/^(host|content-length|connection|transfer-encoding|upgrade)$/i.test(key)) throw new Error('Header not allowed: ' + key);
  }
  if (args.auth) headers.Authorization = 'Bearer ' + secret(args.auth);
  let body = args.body;
  if (body != null && typeof body !== 'string') { headers['Content-Type'] = headers['Content-Type'] || 'application/json'; body = JSON.stringify(body); }
  if (['GET', 'HEAD'].includes(method) && body != null) throw new Error(method + ' cannot have a body');
  const timeout = Math.max(5, Math.min(120, Number(args.timeoutSec) || 30));
  const res = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeout * 1000) });
  const text = await res.text();
  const type = res.headers.get('content-type') || '';
  const location = res.headers.get('location');
  const clipped = text.length > 30000 ? text.slice(0, 30000) + '\n...[truncated]' : text;
  return 'HTTP ' + res.status + ' ' + method + ' ' + url.toString() + '\nContent-Type: ' + type + (location ? '\nLocation: ' + location : '') + '\n\n' + clipped;
}
