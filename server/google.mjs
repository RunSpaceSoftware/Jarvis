import fs from 'node:fs';
import path from 'node:path';
import { SECRETS_DIR } from './config.mjs';

const CLIENT_FILE = path.join(SECRETS_DIR, 'google_client.json');
const TOKEN_FILE = path.join(SECRETS_DIR, 'google_token.json');
let cache = { token: '', expires: 0 };

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function client() {
  const raw = readJson(CLIENT_FILE);
  const c = raw?.installed || raw?.web || raw;
  if (!c?.client_id || !c?.client_secret) throw new Error('Google OAuth client missing. Save secrets/google_client.json and run npm run google-auth.');
  return c;
}

async function accessToken() {
  if (cache.token && cache.expires > Date.now() + 60000) return cache.token;
  const c = client();
  const saved = readJson(TOKEN_FILE);
  if (!saved?.refresh_token) throw new Error('Google account not connected. Run npm run google-auth.');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: saved.refresh_token, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(20000)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error('Google token refresh failed: ' + (json.error_description || json.error || res.status));
  cache = { token: json.access_token, expires: Date.now() + (Number(json.expires_in) || 3600) * 1000 };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...saved, ...json, refresh_token: saved.refresh_token }, null, 2) + '\n');
  return cache.token;
}

async function googleFetch(url, opts = {}) {
  const token = await accessToken();
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json', ...(opts.headers || {}) };
  let body = opts.body;
  if (body && typeof body !== 'string') { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  const res = await fetch(url, { ...opts, headers, body, signal: opts.signal || AbortSignal.timeout(30000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error('Google API ' + res.status + ': ' + (json?.error?.message || json?.error_description || text.slice(0, 400) || 'failed'));
  return json ?? text;
}

const b64urlDecode = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const header = (p, name) => p?.headers?.find((h) => String(h.name || '').toLowerCase() === name.toLowerCase())?.value || '';
const stripHtml = (s) => String(s || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

function bodyText(payload) {
  const plain = [], rich = [];
  const visit = (part) => {
    if (!part) return;
    const data = part.body?.data ? b64urlDecode(part.body.data) : '';
    if (part.mimeType === 'text/plain' && data) plain.push(data);
    else if (part.mimeType === 'text/html' && data) rich.push(data);
    for (const child of part.parts || []) visit(child);
  };
  visit(payload);
  return plain.length ? plain.join('\n').trim() : stripHtml(rich.join('\n'));
}

async function emailList(args) {
  const q = String(args.query || 'in:inbox').slice(0, 500);
  const max = Math.max(1, Math.min(25, Number(args.max) || 10));
  const list = await googleFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?' + new URLSearchParams({ q, maxResults: String(max) }));
  const ids = (list.messages || []).map((m) => m.id);
  if (!ids.length) return 'No messages match ' + q;
  const rows = [];
  for (const id of ids) {
    const m = await googleFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + encodeURIComponent(id) + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date');
    rows.push('#' + id + '\n  From: ' + header(m.payload, 'From') + '\n  Subject: ' + header(m.payload, 'Subject') + '\n  Date: ' + header(m.payload, 'Date') + '\n  ' + (m.snippet || ''));
  }
  return rows.join('\n\n');
}

async function emailRead(args) {
  const id = String(args.id || '');
  if (!id) throw new Error('id is required');
  const m = await googleFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + encodeURIComponent(id) + '?format=full');
  return ['From: ' + header(m.payload, 'From'), 'To: ' + header(m.payload, 'To'), 'Subject: ' + header(m.payload, 'Subject'), 'Date: ' + header(m.payload, 'Date'), '', bodyText(m.payload) || '(no text body)'].join('\n');
}

const encodeHeader = (s) => /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';

async function emailSend(args) {
  if (args.confirm !== true) throw new Error('Set confirm=true only after the user explicitly approves this email');
  const to = String(args.to || '').trim();
  const subject = String(args.subject || '').trim();
  const body = String(args.body || '');
  if (!to || !subject || !body) throw new Error('to, subject and body are required');
  if (/[\r\n]/.test(to + subject)) throw new Error('to and subject cannot contain line breaks');
  const encoded = Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const raw = ['To: ' + to, 'Subject: ' + encodeHeader(subject), 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encoded].join('\r\n');
  const sent = await googleFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', body: { raw: Buffer.from(raw, 'utf8').toString('base64url') } });
  return 'Email sent. Gmail id: ' + (sent.id || '(unknown)');
}

async function calendarList(args) {
  const from = args.from ? new Date(args.from) : new Date();
  const to = (args.toDate || args.to) ? new Date(args.toDate || args.to) : new Date(Date.now() + 7 * 86400000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error('from/to must be valid dates');
  const max = Math.max(1, Math.min(50, Number(args.max) || 20));
  const events = await googleFetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?' + new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: String(max) }));
  if (!events.items?.length) return 'No calendar events in that window.';
  return events.items.map((e) => [e.start?.dateTime || e.start?.date || '', '→ ' + (e.end?.dateTime || e.end?.date || ''), e.summary || '(no title)', e.location ? '@ ' + e.location : '', e.htmlLink || ''].filter(Boolean).join('\n  ')).join('\n\n');
}

async function calendarCreate(args) {
  if (args.confirm !== true) throw new Error('Set confirm=true only after the user explicitly approves this event');
  const summary = String(args.summary || '').trim();
  const start = String(args.start || '').trim();
  const end = String(args.end || '').trim();
  if (!summary || !start || !end) throw new Error('summary, start and end are required');
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end);
  const event = { summary, description: String(args.description || ''), start: dateOnly ? { date: start } : { dateTime: start }, end: dateOnly ? { date: end } : { dateTime: end } };
  const created = await googleFetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', { method: 'POST', body: event });
  return 'Event created: ' + (created.htmlLink || created.id || summary);
}

export async function googleTool(args = {}) {
  const action = String(args.action || 'status');
  if (action === 'status') return 'Google: ' + (readJson(TOKEN_FILE)?.refresh_token ? 'connected (Gmail + Calendar)' : 'not connected. Save secrets/google_client.json and run npm run google-auth.');
  if (action === 'email_list') return await emailList(args);
  if (action === 'email_read') return await emailRead(args);
  if (action === 'email_send') return await emailSend(args);
  if (action === 'calendar_list') return await calendarList(args);
  if (action === 'calendar_create') return await calendarCreate(args);
  throw new Error('Unknown google action: ' + action);
}
