import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, assertPublicUrl, safeFetchText } from './netguard.mjs';
import { originProblem, tokenOk, allowedHostSet, linkTokenOk } from './auth.mjs';
import { requireApproval, listApprovals, resolveApproval } from './approvals.mjs';
import { executeTool } from './tools.mjs';
import { mergeConfig, isLocalBase } from './config.mjs';

test('isPrivateAddress blocks loopback, private, link-local and mapped forms', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', '64:ff9b::7f00:1', '2002:7f00:1::']) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(a), false, a);
});

test('assertPublicUrl rejects local targets and odd encodings', () => {
  for (const u of ['http://localhost:8787/', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data',
    'http://2130706433/', 'http://0x7f.0.0.1/', 'http://127.1/', 'http://foo.localhost/', 'file:///etc/passwd', 'http://user:pw@example.com/']) {
    assert.throws(() => assertPublicUrl(u), undefined, u);
  }
  assert.doesNotThrow(() => assertPublicUrl('https://example.com/path'));
});

test('safeFetchText refuses loopback servers', async () => {
  const http = await import('node:http');
  const srv = http.createServer((q, r) => r.end('secret'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(safeFetchText('http://127.0.0.1:' + srv.address().port + '/'), /Blocked/);
  } finally { srv.close(); }
});

const hosts = allowedHostSet({ server: { host: '127.0.0.1' } }, 8787);
const req = (headers, method = 'GET') => ({ headers, method });
const api = new URL('http://localhost/api/config');

test('originProblem: host, origin, fetch-site and content-type rules', () => {
  assert.equal(originProblem(req({ host: '127.0.0.1:8787' }), api, hosts), null);
  assert.equal(originProblem(req({ host: 'localhost:8787', origin: 'http://localhost:8787' }), api, hosts), null);
  assert.equal(originProblem(req({ host: 'evil.example:8787' }), api, hosts)?.status, 403);          // DNS rebinding
  assert.equal(originProblem(req({ host: '127.0.0.1:8787', origin: 'https://evil.example' }), api, hosts)?.status, 403);
  assert.equal(originProblem(req({ host: '127.0.0.1:8787', origin: 'null' }), api, hosts)?.status, 403);
  assert.equal(originProblem(req({ host: '127.0.0.1:8787', 'sec-fetch-site': 'cross-site' }), api, hosts)?.status, 403);
  assert.equal(originProblem(req({ host: '127.0.0.1:8787', 'content-length': '10', 'content-type': 'text/plain' }, 'POST'), api, hosts)?.status, 415);
  assert.equal(originProblem(req({ host: '127.0.0.1:8787', 'content-length': '10', 'content-type': 'application/json' }, 'POST'), api, hosts), null);
});

test('token is accepted from cookie, header or bearer only', () => {
  const t = 'a'.repeat(64);
  assert.equal(tokenOk(req({ cookie: 'x=1; jarvis_token=' + t }), t), true);
  assert.equal(tokenOk(req({ 'x-jarvis-token': t }), t), true);
  assert.equal(tokenOk(req({ authorization: 'Bearer ' + t }), t), true);
  assert.equal(tokenOk(req({ cookie: 'jarvis_token=' + 'b'.repeat(64) }), t), false);
  assert.equal(tokenOk(req({}), t), false);
  assert.equal(linkTokenOk(t, t), true);
  assert.equal(linkTokenOk('', t), false);
});

test('approvals: approve, deny and abort', async () => {
  const cfg = { safety: { requireApproval: true }, agent: { approvalTimeoutSec: 30 } };
  const a = requireApproval({ cfg }, 't', 'do it');
  assert.equal(listApprovals().length, 1);
  resolveApproval(listApprovals()[0].id, true);
  await a;
  const b = requireApproval({ cfg }, 't', 'do it');
  resolveApproval(listApprovals()[0].id, false);
  await assert.rejects(b, /Not approved/);
  const ac = new AbortController();
  const c = requireApproval({ cfg, signal: ac.signal }, 't', 'do it');
  ac.abort();
  await assert.rejects(c, /Not approved/);
  assert.equal(listApprovals().length, 0);
});

test('a model-supplied confirm=true does not skip approval', async () => {
  const cfg = { safety: { requireApproval: true }, agent: { approvalTimeoutSec: 30 } };
  let requestedId = null;
  const ctx = { cfg, emit: (type, p) => { if (type === 'approval' && p.action === 'requested') requestedId = p.id; } };
  const run = executeTool('google', { action: 'email_send', to: 'a@b.c', subject: 's', body: 'b', confirm: true }, ctx);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(requestedId, 'approval was requested even though confirm=true was passed');
  resolveApproval(requestedId, false);
  assert.match(await run, /^ERROR: Not approved/);
});

test('config merge ignores prototype-pollution keys', () => {
  mergeConfig({}, JSON.parse('{"__proto__":{"polluted":"yes"},"a":{"constructor":{"prototype":{"p2":1}}}}'));
  assert.equal({}.polluted, undefined);
  assert.equal({}.p2, undefined);
});

test('isLocalBase parses the hostname instead of searching the string', () => {
  assert.equal(isLocalBase('http://localhost:11434/v1'), true);
  assert.equal(isLocalBase('http://127.0.0.1:1234/v1'), true);
  assert.equal(isLocalBase('https://evil.example/localhost'), false);
  assert.equal(isLocalBase('https://localhost.evil.example/v1'), false);
});
