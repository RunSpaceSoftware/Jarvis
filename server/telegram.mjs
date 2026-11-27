import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { listApprovals, resolveApproval } from './approvals.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ensureWorkspace, telegramToken, saveConfig } from './config.mjs';
import * as store from './store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (method) => 'https://api.telegram.org/bot' + telegramToken() + '/' + method;
const MAX_DOWNLOAD = 20 * 1024 * 1024;
const MAX_UPLOAD = 50 * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const ATTACHMENT_EXT = new Set([...IMAGE_EXT, '.pdf', '.docx', '.xlsx', '.xlsm', '.pptx', '.txt', '.md', '.markdown', '.csv', '.json', '.log', '.xml', '.html', '.htm', '.yaml', '.yml']);
const MIME_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.log': 'text/plain', '.xml': 'application/xml', '.html': 'text/html', '.htm': 'text/html', '.yaml': 'text/yaml', '.yml': 'text/yaml' };
const EXT_BY_MIME = Object.fromEntries(Object.entries(MIME_TYPES).map(([ext, mime]) => [mime, ext]));
EXT_BY_MIME['image/jpeg'] = '.jpg';

export function safeAttachmentName(name, mime, fallbackExt = '') {
  const leaf = path.posix.basename(String(name || '').replace(/\\/g, '/')).trim();
  const originalExt = path.posix.extname(leaf);
  const rawExt = originalExt.toLowerCase();
  const ext = rawExt || EXT_BY_MIME[String(mime || '').toLowerCase()] || String(fallbackExt || '').toLowerCase();
  if (!ATTACHMENT_EXT.has(ext)) throw new Error('Unsupported attachment type. Send PDF, DOCX, XLSX, PPTX, CSV, text or an image.');
  const base = path.posix.basename(leaf, originalExt).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '').slice(0, 80) || 'file';
  return base + ext;
}

export class Telegram {
  constructor(cfg, agent) {
    this.cfg = cfg;
    this.agent = agent;
    this.state = 'off';
    this.error = '';
    this.offset = Number(store.kvGet('tg_offset', 0)) || 0;
    this.stopped = false;
    this.me = null;
    this.voiceAvailable = null;
    this.lastVoiceAt = Number(store.kvGet('tg_last_voice', 0)) || 0;
    this.sent = 0;
  }

  ready() {
    return Boolean(telegramToken()) && (this.state === 'polling' || this.state === 'idle') && !this.stopped;
  }

  status() {
    return {
      state: this.state,
      error: this.error,
      paired: Boolean(this.cfg.telegram.chatId),
      chatId: this.cfg.telegram.chatId ? String(this.cfg.telegram.chatId).slice(0, 4) + '…' : '',
      bot: this.me?.username || '',
      pairCode: this.pairCode(),
      updateMinutes: this.cfg.telegram.updateMinutes,
      autoUpdates: Boolean(this.cfg.agent.autopilot),
      voice: Boolean(this.cfg.telegram.voiceReplies),
      sent: this.sent
    };
  }

  rotatePairCode() {
    const code = String(crypto.randomInt(10_000_000, 100_000_000));
    store.kvSet('pair_code', code);
    store.kvSet('pair_code_at', Date.now());
    return code;
  }

  // 8 digits, from a CSPRNG, rotated after use and after 15 minutes.
  pairCode() {
    const code = store.kvGet('pair_code', '');
    const at = Number(store.kvGet('pair_code_at', 0)) || 0;
    if (!code || code.length < 8 || Date.now() - at > 15 * 60 * 1000) return this.rotatePairCode();
    return code;
  }

  pairLocked() {
    this.pairFailures = (this.pairFailures || []).filter((t) => Date.now() - t < 15 * 60 * 1000);
    return this.pairFailures.length >= 5;
  }

  async start() {
    this.stopped = false;
    if (!this.cfg.telegram.enabled) { this.state = 'disabled'; this.emit(); return; }
    if (!telegramToken()) { this.state = 'off'; this.error = 'No bot token in secrets/telegram_token.txt'; this.emit(); return; }
    this.state = 'starting';
    this.error = '';
    this.emit();
    try {
      const me = await fetch(api('getMe'), { signal: AbortSignal.timeout(15000) });
      const data = await me.json();
      if (!data.ok) throw new Error(data.description || 'getMe failed');
      this.me = data.result;
      this.state = 'idle';
      this.emit();
      this.loop().catch((err) => { this.state = 'error'; this.error = err.message; this.emit(); });
    } catch (err) {
      this.state = 'error';
      this.error = err.message;
      this.emit();
    }
  }

  async restart() {
    this.stopped = true;
    await sleep(300);
    this.offset = Number(store.kvGet('tg_offset', this.offset)) || this.offset;
    await this.start();
  }

  async stop() {
    this.stopped = true;
    this.state = 'off';
    this.emit();
  }

  emit() {
    try { this.agent.emit('telegram', this.status()); } catch {}
  }

  async loop() {
    while (!this.stopped) {
      try {
        const res = await fetch(api('getUpdates') + '?timeout=25&allowed_updates=%5B%22message%22%5D&offset=' + (this.offset + 1), {
          signal: AbortSignal.timeout(40000)
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.description || 'getUpdates failed');
        if (this.state !== 'polling') { this.state = 'polling'; this.error = ''; this.emit(); }
        for (const update of data.result || []) {
          this.offset = Math.max(this.offset, update.update_id);
          store.kvSet('tg_offset', this.offset);
          if (update.message) await this.handle(update.message).catch((err) => {
            this.agent.emit('log', { level: 'warn', text: 'Telegram handler: ' + err.message });
          });
        }
      } catch (err) {
        if (this.stopped) return;
        if (err.name !== 'AbortError') {
          this.state = 'error';
          this.error = err.message;
          this.emit();
          await sleep(6000);
        }
      }
    }
  }

  async handle(msg) {
    const chatId = String(msg.chat?.id || '');
    const text = (msg.text || '').trim();
    const hasMedia = Boolean(msg.photo?.length || msg.document);
    if (!chatId || (!text && !hasMedia)) return;
    if (msg.from?.is_bot) return;
    if (msg.chat?.type && msg.chat.type !== 'private') return; // never take commands from groups
    const paired = String(this.cfg.telegram.chatId || '');
    const pairMatch = text.match(/^\/pair\s+(\d{4,8})$/i);
    if (pairMatch) {
      if (this.pairLocked()) { await this.send('Too many wrong codes. Try again in a few minutes.', chatId); return; }
      const given = Buffer.from(pairMatch[1]);
      const expected = Buffer.from(this.pairCode());
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        (this.pairFailures ||= []).push(Date.now());
        await this.send('Pairing code does not match. Open the Jarvis interface → Settings for the current code.', chatId);
        return;
      }
      this.cfg.telegram.chatId = chatId;
      this.cfg.telegram.userId = String(msg.from?.id || '');
      saveConfig(this.cfg);
      this.rotatePairCode();
      await this.send('✅ Paired. I will report mission progress here. Reply to this chat any time to steer me.', chatId);
      store.addEvent('telegram', 'Paired chat ' + chatId);
      this.emit();
      return;
    }
    if (!paired) {
      if (/^\/(start|help)/i.test(text)) {
        await this.send('Jarvis here. To pair this chat, open the local interface → Settings and send:\n/pair <code>', chatId);
      } else {
        await this.send('This bot is not paired with a Jarvis instance. Pair from the local interface first.', chatId);
      }
      return;
    }
    if (chatId !== paired) return;
    const pairedUser = String(this.cfg.telegram.userId || '');
    if (pairedUser && String(msg.from?.id || '') !== pairedUser) return;
    if (hasMedia) { await this.handleAttachment(msg, chatId); return; }
    if (!text) return;
    const decision = text.match(/^\/(approve|deny)\s+(\d+)$/i);
    if (decision) {
      const yes = decision[1].toLowerCase() === 'approve';
      const found = resolveApproval(Number(decision[2]), yes, 'telegram');
      await this.send(found ? (yes ? '✅ Approved #' : '🚫 Denied #') + decision[2] : 'No pending approval #' + decision[2], chatId);
      return;
    }
    if (/^\/approvals/i.test(text)) {
      const open = listApprovals();
      await this.send(open.length ? open.map((a) => '#' + a.id + ' ' + a.tool + '\n' + a.summary).join('\n\n') + '\n\n/approve <id> or /deny <id>' : 'Nothing is waiting for approval.', chatId);
      return;
    }
    if (/^\/start|^\/help/i.test(text)) {
      await this.send('Jarvis online.\n\n/status — current state\n/goals — missions\n/reminders — upcoming reminders\n/goal <text> — start a mission\n/pause — stop autonomous wake-ups\n/resume — resume them\n/stop — stop the current turn\n/approvals — actions waiting for your approval\n/approve <id> · /deny <id>\n/new — fresh thread\n\nOr just talk to me: I will pick it up and reply here.', chatId);
      return;
    }
    if (/^\/status/i.test(text)) { await this.send(this.statusText(), chatId); return; }
    if (/^\/goals/i.test(text)) { await this.send(this.goalsText(), chatId); return; }
    if (/^\/reminders/i.test(text)) { await this.send(this.remindersText(), chatId); return; }
    if (/^\/pause/i.test(text)) {
      this.cfg.agent.autopilot = false;
      saveConfig(this.cfg);
      this.agent.emit('state', this.agent.snapshot());
      await this.send('⏸ Autopilot paused. Missions keep their state; /resume when you want me working in the background again.', chatId);
      return;
    }
    if (/^\/resume/i.test(text)) {
      this.cfg.agent.autopilot = true;
      saveConfig(this.cfg);
      for (const g of store.listGoals(50).filter((x) => x.status === 'active')) store.updateGoal(g.id, { next_wake: Date.now() });
      this.agent.emit('state', this.agent.snapshot());
      this.agent.pump().catch(() => {});
      await this.send('▶️ Autopilot resumed. Wake-ups are scheduled.', chatId);
      return;
    }
    if (/^\/stop/i.test(text)) {
      this.agent.stopCurrent('Stopped from Telegram');
      await this.send('⏹ Stopped the current turn. Missions are still queued; /pause if you want quiet.', chatId);
      return;
    }
    if (/^\/new/i.test(text)) {
      this.agent.newSession('Telegram thread');
      await this.send('🧵 Started a fresh thread.', chatId);
      return;
    }
    if (/^\/goal\s+/i.test(text)) {
      const title = text.replace(/^\/goal\s+/i, '').trim();
      const goal = store.createGoal({ title });
      this.agent.emit('goal', goal);
      this.agent.scheduleWake();
      await this.send('🎯 Mission #' + goal.id + ' queued: ' + title + '\nI will report progress here and keep working in the background.', chatId);
      this.agent.pump().catch(() => {});
      return;
    }
    if (this.agent.pumping) await this.send('⏳ Picked it up. I am mid-task; your message will steer me at the next step.', chatId).catch(() => {});
    this.agent.enqueue(text, 'telegram', { chatId });
  }

  async handleAttachment(msg, chatId) {
    const photo = msg.photo?.at(-1);
    const doc = msg.document;
    const item = doc || photo;
    if (!item?.file_id) return;
    if (Number(item.file_size || 0) > MAX_DOWNLOAD) {
      await this.send('That file is too large for Telegram bots (max 20 MB).', chatId);
      return;
    }
    try {
      const infoRes = await fetch(api('getFile') + '?file_id=' + encodeURIComponent(item.file_id), { signal: AbortSignal.timeout(15000) });
      const info = await infoRes.json();
      if (!info.ok || !info.result?.file_path) throw new Error(info.description || 'getFile failed');
      const filePath = info.result.file_path;
      const name = safeAttachmentName(doc?.file_name || filePath, doc?.mime_type, path.posix.extname(filePath) || (photo ? '.jpg' : ''));
      const ws = ensureWorkspace(this.cfg);
      const dir = path.join(ws, 'telegram-inbox');
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + name);
      const url = 'https://api.telegram.org/file/bot' + telegramToken() + '/' + filePath.split('/').map(encodeURIComponent).join('/');
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error('Telegram file download failed (' + res.status + ')');
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > MAX_DOWNLOAD) throw new Error('File is larger than 20 MB');
      fs.writeFileSync(target, buffer, { mode: 0o600 });
      const rel = path.relative(ws, target).split(path.sep).join('/');
      const isImage = IMAGE_EXT.has(path.extname(name).toLowerCase());
      const caption = String(msg.caption || '').trim().slice(0, 2000);
      const prompt = [
        'Telegram attachment saved in the workspace.',
        'Path: ' + rel,
        'Kind: ' + (isImage ? 'image' : 'document'),
        caption ? 'Caption: ' + caption : '',
        isImage ? 'Use see_image on this path.' : 'Use read_document on this path.',
        'Reply to the user in Telegram with what you find or any answer they asked for.'
      ].filter(Boolean).join('\n');
      await this.send('📎 Received ' + rel + '. Looking at it now.', chatId);
      if (this.agent.pumping) await this.send('⏳ I am mid-task; this file will be handled at the next step.', chatId).catch(() => {});
      this.agent.enqueue(prompt, 'telegram', { chatId });
    } catch (err) {
      this.agent.emit('log', { level: 'warn', text: 'Telegram attachment: ' + err.message });
      await this.send('Could not accept that attachment: ' + err.message, chatId).catch(() => {});
    }
  }

  statusText() {
    const snap = this.agent.snapshot();
    const active = snap.goals.filter((g) => g.status === 'active');
    return [
      '🤖 Jarvis — ' + snap.mode,
      snap.detail,
      'Autopilot: ' + (snap.autopilot ? 'ON' : 'OFF') + ' · queue: ' + snap.queued,
      'Missions active: ' + active.length,
      active.map((g) => '  #' + g.id + ' ' + g.progress + '% — ' + g.title).join('\n'),
      'Reminders pending: ' + (snap.reminders || []).length,
      'MCP servers: ' + snap.mcp.filter((m) => m.state === 'ready').length + '/' + snap.mcp.length,
      'Uptime: ' + Math.floor(snap.uptime / 60) + 'm'
    ].filter(Boolean).join('\n');
  }

  remindersText() {
    const rows = store.listReminders(20);
    if (!rows.length) return 'No pending reminders. Ask me in chat: “remind me in 30 minutes to …”.';
    return rows.map((r) => '#' + r.id + ' · ' + new Date(r.due_at).toLocaleString() + ' · ' + r.text + (r.repeat_sec ? ' · every ' + r.repeat_sec + 's' : '')).join('\n');
  }

  goalsText() {
    const goals = store.listGoals(20);
    if (!goals.length) return 'No missions yet. Use /goal <text> to start one.';
    return goals.map((g) => '#' + g.id + ' [' + g.status + '] ' + g.progress + '% — ' + g.title + (g.note ? '\n   ' + g.note.slice(0, 160) : '')).join('\n');
  }

  voiceDue(now = Date.now()) {
    const minutes = Math.max(1, Number(this.cfg.telegram.updateMinutes) || 60);
    return now - this.lastVoiceAt >= minutes * 60000;
  }

  async send(text, chatId, opts = {}) {
    const target = chatId || this.cfg.telegram.chatId;
    if (!target) throw new Error('No paired Telegram chat');
    if (!telegramToken()) throw new Error('No Telegram bot token');
    const clean = String(text || '').trim();
    if (!clean) return 'Nothing to send.';
    const chunks = [];
    for (let i = 0; i < clean.length; i += 3800) chunks.push(clean.slice(i, i + 3800));
    for (const chunk of chunks) {
      const res = await fetch(api('sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: target, text: chunk, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(20000)
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.description || 'sendMessage failed');
      this.sent++;
    }
    if (opts.voice && this.cfg.telegram.voiceReplies && this.voiceDue()) {
      this.lastVoiceAt = Date.now();
      store.kvSet('tg_last_voice', this.lastVoiceAt);
      this.sendVoice(clean, target).catch(() => {});
    }
    return 'Sent to Telegram.';
  }

  async sendFile(file, opts = {}) {
    const target = String(opts.chatId || this.cfg.telegram.chatId || '');
    if (!target) throw new Error('No paired Telegram chat');
    if (!telegramToken()) throw new Error('No Telegram bot token');
    const name = path.basename(file);
    const ext = path.extname(name).toLowerCase();
    const size = fs.statSync(file).size;
    if (size > MAX_UPLOAD) throw new Error('File is larger than 50 MB');
    const asPhoto = IMAGE_EXT.has(ext) && ext !== '.gif' && size <= 10 * 1024 * 1024;
    const form = new FormData();
    form.append('chat_id', target);
    const caption = String(opts.caption || '').trim().slice(0, 1024);
    if (caption) form.append('caption', caption);
    form.append(asPhoto ? 'photo' : 'document', new Blob([fs.readFileSync(file)], { type: MIME_TYPES[ext] || 'application/octet-stream' }), name);
    const res = await fetch(api(asPhoto ? 'sendPhoto' : 'sendDocument'), { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(data.description || 'Telegram file send failed');
    this.sent++;
    return 'Sent ' + name + ' to Telegram.';
  }

  async canVoice() {
    if (this.voiceAvailable != null) return this.voiceAvailable;
    this.voiceAvailable = await new Promise((resolve) => {
      const child = spawn('python', ['-c', 'import edge_tts'], { windowsHide: true });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
    return this.voiceAvailable;
  }

  async sendVoice(text, chatId) {
    if (!(await this.canVoice())) return;
    const file = path.join(DATA_DIR, 'voice-' + Date.now() + '.mp3');
    const clean = text.replace(/https?:\/\/\S+/g, '').slice(0, 900);
    if (!clean.trim()) return;
    const ok = await new Promise((resolve) => {
      const child = spawn('python', ['-m', 'edge_tts', '--voice', 'en-GB-RyanNeural', '--text', clean, '--write-media', file], { windowsHide: true });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0 && fs.existsSync(file)));
    });
    if (!ok) return;
    try {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('title', 'Jarvis update');
      form.append('audio', new Blob([fs.readFileSync(file)], { type: 'audio/mpeg' }), 'jarvis.mp3');
      const res = await fetch(api('sendAudio'), { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
      const data = await res.json();
      if (!data.ok) this.agent.emit('log', { level: 'warn', text: 'Telegram voice: ' + (data.description || 'failed') });
    } finally {
      try { fs.unlinkSync(file); } catch {}
    }
  }
}
