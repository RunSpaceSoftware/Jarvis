import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, telegramToken, saveConfig } from './config.mjs';
import * as store from './store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (method) => 'https://api.telegram.org/bot' + telegramToken() + '/' + method;

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

  pairCode() {
    let code = store.kvGet('pair_code', '');
    if (!code) {
      code = String(Math.floor(100000 + Math.random() * 900000));
      store.kvSet('pair_code', code);
    }
    return code;
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
    if (!chatId || !text) return;
    if (msg.from?.is_bot) return;
    const paired = String(this.cfg.telegram.chatId || '');
    const pairMatch = text.match(/^\/pair\s+(\d{4,8})$/i);
    if (pairMatch) {
      if (pairMatch[1] !== this.pairCode()) { await this.send('Pairing code does not match. Open the Jarvis interface → Settings for the current code.', chatId); return; }
      this.cfg.telegram.chatId = chatId;
      saveConfig(this.cfg);
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
    if (/^\/start|^\/help/i.test(text)) {
      await this.send('Jarvis online.\n\n/status — current state\n/goals — missions\n/reminders — upcoming reminders\n/goal <text> — start a mission\n/pause — stop autonomous wake-ups\n/resume — resume them\n/stop — stop the current turn\n/new — fresh thread\n\nOr just talk to me: I will pick it up and reply here.', chatId);
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

  async send(text, chatId) {
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
    if (this.cfg.telegram.voiceReplies) this.sendVoice(clean, target).catch(() => {});
    return 'Sent to Telegram.';
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
      const child = spawn('python', ['-m', 'edge_tts', '--voice', 'en-US-GuyNeural', '--text', clean, '--write-media', file], { windowsHide: true });
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
