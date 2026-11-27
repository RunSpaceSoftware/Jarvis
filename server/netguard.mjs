// SSRF protection: refuse to talk to loopback / private / link-local addresses.
// The check happens inside the socket's DNS lookup, so the address that is
// validated is the address that is actually connected to (no DNS-rebinding gap).
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

function isPrivate4(addr) {
  const [a, b] = addr.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||   // CGNAT
    (a === 169 && b === 254) ||             // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||               // 192.0.0.0/24, 192.0.2.0/24
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224                                // multicast + reserved + broadcast
  );
}

function isPrivate6(addr) {
  const a = addr.toLowerCase();
  if (a === '::' || a === '::1') return true;
  const dotted = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isPrivate4(dotted[1]);
  const hex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isPrivate4([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
  }
  if (/^::(?!ffff:)/.test(a)) return true;                 // IPv4-compatible and other ::/96 forms
  if (/^(fe[89ab]|fc|fd|ff)/.test(a)) return true;       // link-local, ULA, multicast
  if (a.startsWith('64:ff9b:') || a.startsWith('2002:') || a.startsWith('2001:0:') || a.startsWith('2001:db8:')) return true; // NAT64, 6to4, Teredo, docs
  return false;
}

export function isPrivateAddress(input) {
  let a = String(input || '').trim();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const family = net.isIP(a);
  if (family === 4) return isPrivate4(a);
  if (family === 6) return isPrivate6(a);
  return true; // not an IP at all: treat as unsafe
}

function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (typeof options === 'number') options = { family: options };
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const bad = addresses.find((x) => isPrivateAddress(x.address));
    if (bad) return callback(new Error('Blocked: ' + hostname + ' resolves to a private or local address (' + bad.address + ')'));
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

// Synchronous checks that do not need DNS. IP literals skip the socket lookup,
// so they have to be rejected here.
export function assertPublicUrl(input) {
  let url;
  try { url = input instanceof URL ? input : new URL(String(input)); }
  catch { throw new Error('A full http(s) URL is required'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http(s) URLs are allowed');
  if (url.username || url.password) throw new Error('Credentials in URLs are not allowed');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw new Error('URL has no host');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Blocked: ' + host + ' is a local name');
  }
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error('Blocked: ' + host + ' is a private or local address');
  return url;
}

// Resolve-and-check, for callers that cannot pin the connection (e.g. a real browser).
export async function assertPublicHost(input) {
  const url = assertPublicUrl(input);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return url;
  const addresses = await dns.promises.lookup(host, { all: true });
  const bad = addresses.find((x) => isPrivateAddress(x.address));
  if (bad) throw new Error('Blocked: ' + host + ' resolves to a private or local address (' + bad.address + ')');
  return url;
}

function requestOnce(url, { signal, headers, maxBytes }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method: 'GET', headers, lookup: guardedLookup, signal }, (res) => {
      const out = { status: res.statusCode || 0, headers: res.headers };
      if ([301, 302, 303, 307, 308].includes(out.status) && res.headers.location) {
        res.resume();
        return resolve({ ...out, text: '' });
      }
      let stream = res;
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      let size = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve({ ...out, text: Buffer.concat(chunks).toString('utf8') });
      };
      stream.on('data', (chunk) => {
        if (done) return;
        size += chunk.length;
        chunks.push(chunk);
        if (size > maxBytes) { finish(); res.destroy(); }
      });
      stream.on('end', finish);
      stream.on('close', finish);
      stream.on('error', (err) => { if (!done) { done = true; reject(err); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// GET a public URL and return { res: { status, headers.get() }, text }.
export async function safeFetchText(rawUrl, opts = {}) {
  const maxBytes = opts.maxBytes || 2_000_000;
  const maxRedirects = opts.maxRedirects ?? 5;
  const timeout = AbortSignal.timeout(opts.timeoutMs || 25000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const headers = { 'Accept-Encoding': 'gzip, deflate, br', ...(opts.headers || {}) };
  let url = assertPublicUrl(rawUrl);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const r = await requestOnce(url, { signal, headers, maxBytes });
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
      url = assertPublicUrl(new URL(r.headers.location, url));
      continue;
    }
    const lower = {};
    for (const [k, v] of Object.entries(r.headers)) lower[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    return { res: { status: r.status, url: url.toString(), headers: { get: (k) => lower[String(k).toLowerCase()] ?? null } }, text: r.text };
  }
  throw new Error('Too many redirects');
}
