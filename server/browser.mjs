import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, ensureWorkspace } from './config.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let active = null;

function candidates(cfg) {
  const out = [];
  if (cfg.integrations?.browser?.path) out.push(cfg.integrations.browser.path);
  if (process.env.JARVIS_BROWSER_PATH) out.push(process.env.JARVIS_BROWSER_PATH);
  if (process.env.LOCALAPPDATA) {
    out.push(
      process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
      process.env.LOCALAPPDATA + '/Microsoft/Edge/Application/msedge.exe'
    );
  }
  if (process.env.PROGRAMFILES) out.push(process.env.PROGRAMFILES + '/Google/Chrome/Application/chrome.exe', process.env.PROGRAMFILES + '/Microsoft/Edge/Application/msedge.exe');
  if (process.env['PROGRAMFILES(X86)']) out.push(process.env['PROGRAMFILES(X86)'] + '/Google/Chrome/Application/chrome.exe', process.env['PROGRAMFILES(X86)'] + '/Microsoft/Edge/Application/msedge.exe');
  if (process.platform === 'win32') {
    out.push(
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe'
    );
  } else if (process.platform === 'darwin') {
    out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    out.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }
  return out;
}

function findBrowser(cfg) {
  const found = candidates(cfg).find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!found) throw new Error('No Chrome/Edge found. Set integrations.browser.path in config/config.json.');
  return found;
}

async function json(url, opts) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('Browser debugger HTTP ' + res.status);
  return res.json();
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.next = 1;
    this.pending = new Map();
    this.waiters = new Map();
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 10000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket failed')); }, { once: true });
    });
    this.ws.addEventListener('message', (event) => this.onMessage(event.data));
    this.ws.addEventListener('close', () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP connection closed')); }
      this.pending.clear();
      for (const list of this.waiters.values()) for (const w of list) { clearTimeout(w.timer); w.reject(new Error('CDP connection closed')); }
      this.waiters.clear();
    });
  }

  onMessage(raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
      else p.resolve(msg.result || {});
      return;
    }
    const list = this.waiters.get(msg.method);
    if (!list?.length) return;
    const waiter = list.shift();
    if (!list.length) this.waiters.delete(msg.method);
    clearTimeout(waiter.timer);
    waiter.resolve(msg.params || {});
  }

  async send(method, params = {}, timeout = 20000) {
    await this.ready;
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timed out')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }

  waitEvent(method, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(method) || [];
      const w = { resolve, reject, timer: setTimeout(() => {
        const cur = this.waiters.get(method) || [];
        this.waiters.set(method, cur.filter((x) => x !== w));
        reject(new Error(method + ' timed out'));
      }, timeout) };
      list.push(w);
      this.waiters.set(method, list);
    });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || r.exceptionDetails.exception?.description || 'Page script failed');
    return r.result?.value;
  }

  close() { try { this.ws.close(); } catch {} }
}

function snapExpr() {
  const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 12000);
  const all = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]')];
  const elements = [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || s.visibility === 'hidden' || s.display === 'none' || s.pointerEvents === 'none') continue;
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const item = { ref: String(elements.length), tag: el.tagName.toLowerCase(), label };
    if (el.tagName === 'A' && el.href) item.href = el.href;
    if (el.tagName === 'INPUT') item.type = el.type || 'text';
    if (el.tagName === 'SELECT') item.options = [...el.options].slice(0, 12).map((o) => o.text.trim()).filter(Boolean);
    if (el.disabled) item.disabled = true;
    el.setAttribute('data-jarvis-ref', item.ref);
    elements.push(item);
    if (elements.length >= 100) break;
  }
  return { title: document.title || '', url: location.href, text, elements };
}

class Browser {
  constructor(cfg) {
    this.cfg = cfg;
    this.port = Math.max(1024, Number(cfg.integrations?.browser?.port) || 9222);
    this.cdp = null;
    this.proc = null;
    this.launched = false;
  }

  async ensure() {
    if (this.cdp) return;
    let version;
    try { version = await json('http://127.0.0.1:' + this.port + '/json/version'); }
    catch { await this.launch(); version = await this.waitForVersion(); }
    let page;
    try {
      page = await json('http://127.0.0.1:' + this.port + '/json/new?about:blank', { method: 'PUT' });
    } catch {
      const pages = await json('http://127.0.0.1:' + this.port + '/json/list');
      page = pages.find((p) => p.type === 'page');
    }
    if (!page) throw new Error('Browser has no page target');
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    this.cdp = cdp;
    cdp.ws.addEventListener('close', () => { if (this.cdp === cdp) this.cdp = null; });
    await cdp.ready;
    await cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
  }

  async launch() {
    const exe = findBrowser(this.cfg);
    const profile = path.join(DATA_DIR, 'browser-profile');
    fs.mkdirSync(profile, { recursive: true });
    const args = [
      '--remote-debugging-port=' + this.port,
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-crash-reporter',
      '--disable-breakpad',
      '--disable-gpu',
      '--remote-allow-origins=*',
      'about:blank'
    ];
    if (this.cfg.integrations?.browser?.headless) args.unshift('--headless=new');
    const log = fs.openSync(path.join(profile, 'browser.log'), 'a');
    this.proc = spawn(exe, args, { detached: true, stdio: ['ignore', 'ignore', log], windowsHide: true });
    try { fs.closeSync(log); } catch {}
    this.proc.unref();
    this.launched = true;
  }

  async waitForVersion() {
    const started = Date.now();
    while (Date.now() - started < 20000) {
      try { return await json('http://127.0.0.1:' + this.port + '/json/version'); }
      catch {
        if (this.proc?.exitCode != null) {
          let log = '';
          try { log = fs.readFileSync(path.join(DATA_DIR, 'browser-profile', 'browser.log'), 'utf8').slice(-1200); } catch {}
          throw new Error('Browser exited with code ' + this.proc.exitCode + (log ? ': ' + log : ''));
        }
        await sleep(350);
      }
    }
    throw new Error('Browser did not open its debugger port ' + this.port);
  }

  async open(url) {
    if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('Only http(s) URLs are allowed');
    await this.ensure();
    const loaded = this.cdp.waitEvent('Page.loadEventFired', 20000).catch(() => null);
    await this.cdp.send('Page.navigate', { url: String(url) });
    await Promise.race([loaded, sleep(9000)]);
    await sleep(400);
    return this.snapshot();
  }

  async snapshot() {
    await this.ensure();
    return await this.cdp.evaluate('(' + snapExpr.toString() + ')()');
  }

  async click(ref) {
    await this.ensure();
    const r = await this.cdp.evaluate('(() => { const el = document.querySelector(\'[data-jarvis-ref="' + String(ref).replace(/\D/g, '') + '"]\'); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true; })()');
    if (!r) throw new Error('No element with ref ' + ref + '. Take a new snapshot.');
    await sleep(900);
    return this.snapshot();
  }

  async type(ref, text, submit) {
    await this.ensure();
    const expr = '(() => { const el = document.querySelector(\'[data-jarvis-ref="' + String(ref).replace(/\D/g, '') + '"]\'); if (!el) return false; el.focus(); const value = ' + JSON.stringify(String(text)) + '; if (el.isContentEditable) { el.textContent = value; } else { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const set = Object.getOwnPropertyDescriptor(proto, "value")?.set; if (set) set.call(el, value); else el.value = value; } el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); ' + (submit ? 'if (el.form) el.form.requestSubmit(); else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));' : '') + ' return true; })()';
    const r = await this.cdp.evaluate(expr);
    if (!r) throw new Error('No element with ref ' + ref + '. Take a new snapshot.');
    await sleep(submit ? 1100 : 400);
    return this.snapshot();
  }

  async screenshot() {
    await this.ensure();
    const r = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    const ws = ensureWorkspace(this.cfg);
    const name = 'browser-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
    const file = path.join(ws, name);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return name;
  }

  async close() {
    if (this.cdp) {
      if (this.launched) { try { await this.cdp.send('Browser.close', {}, 3000); } catch {} }
      this.cdp.close();
      this.cdp = null;
    }
    if (this.launched && this.proc?.pid) { try { process.kill(this.proc.pid); } catch {} }
    this.proc = null;
    this.launched = false;
  }
}

function getBrowser(cfg) {
  if (!active) active = new Browser(cfg);
  else active.cfg = cfg;
  return active;
}

function format(s) {
  const lines = ['Title: ' + (s.title || '(none)'), 'URL: ' + (s.url || '')];
  if (s.elements?.length) {
    lines.push('', 'Interactive elements:');
    for (const e of s.elements) {
      const extra = [e.type, e.href, e.options ? 'options: ' + e.options.join(' | ') : '', e.disabled ? 'disabled' : ''].filter(Boolean).join(' · ');
      lines.push('[' + e.ref + '] <' + e.tag + '> ' + (e.label || '(no label)') + (extra ? ' — ' + extra : ''));
    }
  }
  lines.push('', 'Page text:', s.text || '(empty)');
  return lines.join('\n');
}

export async function browserTool(args = {}, cfg) {
  const b = getBrowser(cfg);
  const action = String(args.action || 'snapshot');
  if (action === 'open') return format(await b.open(args.url));
  if (action === 'snapshot') return format(await b.snapshot());
  if (action === 'click') { if (!args.ref) throw new Error('ref is required'); return format(await b.click(args.ref)); }
  if (action === 'type') { if (!args.ref) throw new Error('ref is required'); return format(await b.type(args.ref, args.text ?? '', Boolean(args.submit))); }
  if (action === 'screenshot') return 'Screenshot saved in the workspace: ' + await b.screenshot();
  if (action === 'close') { await b.close(); return 'Browser closed.'; }
  throw new Error('Unknown browser action: ' + action);
}
