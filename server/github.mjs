import fs from 'node:fs';
import path from 'node:path';
import { SECRETS_DIR } from './config.mjs';

function token() {
  for (const name of ['github_token.txt', 'github.txt']) {
    const file = path.join(SECRETS_DIR, name);
    if (fs.existsSync(file)) {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    }
  }
  return process.env.GITHUB_TOKEN || '';
}

export async function githubTool(args = {}) {
  const key = token();
  if (!key) throw new Error('GitHub token missing. Save it in secrets/github_token.txt.');
  const method = String(args.method || 'GET').toUpperCase();
  const apiPath = String(args.path || '');
  const [rawPath, rawQuery = ''] = apiPath.split('?');
  if (!/^\/[A-Za-z0-9._~\/-]+$/.test(rawPath) || rawPath.includes('..')) throw new Error('path must be a GitHub API path such as /repos/owner/repo');
  const query = rawQuery ? '?' + new URLSearchParams(rawQuery).toString() : '';
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) throw new Error('Unsupported method');
  if (method !== 'GET' && args.confirm !== true) throw new Error('Set confirm=true only after the user explicitly approves this GitHub write');
  let body;
  if (args.body != null) { body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body); }
  const res = await fetch('https://api.github.com' + rawPath + query, {
    method,
    headers: {
      Authorization: 'Bearer ' + key,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jarvis-personal-agent',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body,
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  return 'GitHub ' + method + ' ' + apiPath + ' → ' + res.status + '\n' + (text.length > 16000 ? text.slice(0, 16000) + '\n...[truncated]' : text);
}
