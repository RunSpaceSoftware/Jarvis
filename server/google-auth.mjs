import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { SECRETS_DIR } from './config.mjs';

const PORT = Number(process.env.GOOGLE_OAUTH_PORT) || 8788;
const REDIRECT = 'http://127.0.0.1:' + PORT + '/oauth2callback';
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar'];
const CLIENT_FILE = path.join(SECRETS_DIR, 'google_client.json');
const TOKEN_FILE = path.join(SECRETS_DIR, 'google_token.json');

if (!fs.existsSync(CLIENT_FILE)) {
  console.error('Missing ' + CLIENT_FILE);
  console.error('Create a Google Cloud OAuth client (Desktop app), download the JSON, and save it there.');
  console.error('Then add this redirect URI in the Google Cloud console: ' + REDIRECT);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(CLIENT_FILE, 'utf8'));
const client = raw.installed || raw.web || raw;
if (!client.client_id || !client.client_secret) {
  console.error('google_client.json must contain client_id and client_secret.');
  process.exit(1);
}

const state = crypto.randomBytes(16).toString('hex');
const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: client.client_id,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: SCOPES.join(' '),
  access_type: 'offline',
  prompt: 'consent',
  state
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  if (url.pathname !== '/oauth2callback') { res.writeHead(404); res.end('Not found'); return; }
  if (url.searchParams.get('state') !== state) { res.writeHead(400); res.end('State mismatch.'); return; }
  const code = url.searchParams.get('code');
  if (!code) { res.writeHead(400); res.end('No code returned.'); return; }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: client.client_id, client_secret: client.client_secret, redirect_uri: REDIRECT, grant_type: 'authorization_code' })
    });
    const token = await tokenRes.json();
    if (!tokenRes.ok || !token.refresh_token) throw new Error(token.error_description || token.error || 'No refresh token returned');
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...token, created_at: Date.now() }, null, 2) + '\n');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Google connected. You can close this tab.');
    console.log('Google connected. Token saved to ' + TOKEN_FILE);
    setTimeout(() => { server.close(); process.exit(0); }, 300);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Google connection failed: ' + err.message);
    console.error('Google connection failed:', err.message);
    setTimeout(() => { server.close(); process.exit(1); }, 300);
  }
});

server.on('error', (err) => { console.error('Cannot start OAuth callback server: ' + err.message); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => {
  console.log('Open this URL in your browser and approve access:');
  console.log(authUrl);
  console.log('Waiting on ' + REDIRECT);
});
