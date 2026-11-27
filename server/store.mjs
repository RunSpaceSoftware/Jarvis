import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ensureDirs } from './config.mjs';

ensureDirs();
const db = new DatabaseSync(path.join(DATA_DIR, 'jarvis.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, session_id INTEGER, role TEXT, content TEXT, tool_calls TEXT, tool_call_id TEXT, name TEXT, created_at INTEGER, hidden INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS summaries (session_id INTEGER PRIMARY KEY, content TEXT, through_id INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY, kind TEXT, text TEXT, tags TEXT, created_at INTEGER, last_used INTEGER, uses INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS goals (id INTEGER PRIMARY KEY, title TEXT, detail TEXT, status TEXT, progress INTEGER DEFAULT 0, note TEXT, created_at INTEGER, updated_at INTEGER, next_wake INTEGER, iterations INTEGER DEFAULT 0, last_update INTEGER);
CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, goal_id INTEGER, started_at INTEGER, ended_at INTEGER, status TEXT, summary TEXT, steps INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY, text TEXT NOT NULL, due_at INTEGER NOT NULL, repeat_sec INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', created_at INTEGER, fired_at INTEGER);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, type TEXT, text TEXT, data TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
`);
try { db.exec('ALTER TABLE messages ADD COLUMN hidden INTEGER DEFAULT 0'); } catch {}
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);');
db.exec('CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_at);');
archiveOld();

export function now() { return Date.now(); }
const J = (v) => (v == null ? null : JSON.stringify(v));
const P = (v) => { try { return v == null ? null : JSON.parse(v); } catch { return null; } };

export function kvGet(key, fallback = null) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
export function kvSet(key, value) {
  db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

export function listSessions() {
  return db.prepare('SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 30').all();
}
export function createSession(title = 'New thread') {
  const t = now();
  const info = db.prepare('INSERT INTO sessions(title, created_at, updated_at) VALUES(?, ?, ?)').run(title, t, t);
  const id = Number(info.lastInsertRowid);
  kvSet('session_id', id);
  return id;
}
export function activeSession() {
  let id = Number(kvGet('session_id', 0));
  const exists = id && db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
  if (!exists) {
    const last = db.prepare('SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1').get();
    id = last ? last.id : createSession('First contact');
    kvSet('session_id', id);
  }
  return id;
}
export function setActiveSession(id) {
  kvSet('session_id', id);
}
export function renameSession(id, title) {
  db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, now(), id);
}

export function addMessage(sessionId, msg) {
  const t = now();
  const info = db.prepare('INSERT INTO messages(session_id, role, content, tool_calls, tool_call_id, name, created_at, hidden) VALUES(?,?,?,?,?,?,?,?)')
    .run(sessionId, msg.role, msg.content ?? '', J(msg.tool_calls), msg.tool_call_id ?? null, msg.name ?? null, t, msg.hidden ? 1 : 0);
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(t, sessionId);
  return { id: Number(info.lastInsertRowid), ...msg, created_at: t };
}

export function listMessages(sessionId, limit = 100) {
  const rows = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, limit);
  return rows.reverse().map((r) => ({
    id: r.id, role: r.role, content: r.content, tool_calls: P(r.tool_calls),
    tool_call_id: r.tool_call_id, name: r.name, created_at: r.created_at, hidden: r.hidden
  }));
}

export function countMessagesSince(sessionId, id = 0) {
  return db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ? AND id > ?').get(sessionId, id).c;
}
export function messagesAfter(sessionId, id, limit = 500) {
  return db.prepare('SELECT * FROM messages WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?').all(sessionId, id, limit).map((r) => ({
    id: r.id, role: r.role, content: r.content, tool_calls: P(r.tool_calls),
    tool_call_id: r.tool_call_id, name: r.name, created_at: r.created_at, hidden: r.hidden
  }));
}

export function getSummary(sessionId) {
  return db.prepare('SELECT * FROM summaries WHERE session_id = ?').get(sessionId) || null;
}
export function setSummary(sessionId, content, throughId) {
  db.prepare('INSERT INTO summaries(session_id, content, through_id, updated_at) VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET content = excluded.content, through_id = excluded.through_id, updated_at = excluded.updated_at')
    .run(sessionId, content, throughId, now());
}

export function addMemory(text, kind = 'fact', tags = '') {
  const t = now();
  const info = db.prepare('INSERT INTO memories(kind, text, tags, created_at, last_used, uses) VALUES(?,?,?,?,?,0)').run(kind, text, tags, t, t);
  return Number(info.lastInsertRowid);
}
export function searchMemories(query, limit = 8) {
  const words = String(query || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const uniq = [...new Set(words)].slice(0, 8);
  let rows;
  if (!uniq.length) {
    rows = db.prepare('SELECT * FROM memories ORDER BY last_used DESC LIMIT ?').all(limit);
  } else {
    const where = uniq.map(() => '(lower(text) LIKE ? OR lower(tags) LIKE ?)').join(' OR ');
    const params = uniq.flatMap((w) => ['%' + w + '%', '%' + w + '%']);
    rows = db.prepare('SELECT * FROM memories WHERE ' + where + ' ORDER BY uses DESC, last_used DESC LIMIT ?').all(...params, limit);
  }
  return rows;
}
export function listMemories(limit = 200) {
  return db.prepare('SELECT * FROM memories ORDER BY created_at DESC LIMIT ?').all(limit);
}
export function touchMemories(ids) {
  if (!ids.length) return;
  const stmt = db.prepare('UPDATE memories SET last_used = ?, uses = uses + 1 WHERE id = ?');
  for (const id of ids) stmt.run(now(), id);
}
export function deleteMemory(id) {
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
}

export function createGoal({ title, detail = '', status = 'active' }) {
  const t = now();
  const info = db.prepare('INSERT INTO goals(title, detail, status, progress, note, created_at, updated_at, next_wake, iterations, last_update) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(title, detail, status, 0, '', t, t, t, 0, 0);
  return getGoal(Number(info.lastInsertRowid));
}
export function getGoal(id) {
  return db.prepare('SELECT * FROM goals WHERE id = ?').get(id) || null;
}
export function listGoals(limit = 50) {
  return db.prepare('SELECT * FROM goals ORDER BY CASE status WHEN \'active\' THEN 0 ELSE 1 END, updated_at DESC LIMIT ?').all(limit);
}
export function updateGoal(id, patch) {
  const g = getGoal(id);
  if (!g) return null;
  const next = { ...g, ...patch, updated_at: now() };
  db.prepare('UPDATE goals SET title = ?, detail = ?, status = ?, progress = ?, note = ?, updated_at = ?, next_wake = ?, iterations = ?, last_update = ? WHERE id = ?')
    .run(next.title, next.detail, next.status, next.progress ?? 0, next.note ?? '', next.updated_at, next.next_wake ?? 0, next.iterations ?? 0, next.last_update ?? 0, id);
  return getGoal(id);
}
export function deleteGoal(id) {
  db.prepare('DELETE FROM runs WHERE goal_id = ?').run(id);
  db.prepare('DELETE FROM goals WHERE id = ?').run(id);
}

export function nextDueGoal(at = now()) {
  return db.prepare("SELECT * FROM goals WHERE status = 'active' AND (next_wake IS NULL OR next_wake <= ?) ORDER BY next_wake ASC LIMIT 1").get(at) || null;
}
export function nextWakeTime() {
  const row = db.prepare("SELECT MIN(next_wake) AS t FROM goals WHERE status = 'active'").get();
  return row?.t ?? null;
}

export function createReminder({ text, dueAt, repeatSec = 0 }) {
  const t = now();
  const info = db.prepare('INSERT INTO reminders(text, due_at, repeat_sec, status, created_at) VALUES(?,?,?,?,?)')
    .run(text, Number(dueAt), Math.max(0, Math.floor(Number(repeatSec) || 0)), 'pending', t);
  return getReminder(Number(info.lastInsertRowid));
}
export function getReminder(id) {
  return db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) || null;
}
export function listReminders(limit = 20) {
  return db.prepare("SELECT * FROM reminders WHERE status = 'pending' ORDER BY due_at ASC LIMIT ?").all(limit);
}
export function dueReminders(at = now()) {
  return db.prepare("SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC").all(at);
}
export function fireReminder(id, at = now()) {
  const reminder = getReminder(id);
  if (!reminder || reminder.status !== 'pending') return null;
  if (reminder.repeat_sec > 0) {
    const missed = Math.floor((at - reminder.due_at) / reminder.repeat_sec) + 1;
    db.prepare('UPDATE reminders SET due_at = ?, fired_at = ? WHERE id = ?')
      .run(reminder.due_at + missed * reminder.repeat_sec, at, id);
  } else {
    db.prepare("UPDATE reminders SET status = 'done', fired_at = ? WHERE id = ?").run(at, id);
  }
  return reminder;
}
export function cancelReminder(id) {
  return db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(id).changes > 0;
}
export function deleteReminder(id) {
  db.prepare('DELETE FROM reminders WHERE id = ?').run(id);
}

export function startRun(goalId) {
  const info = db.prepare('INSERT INTO runs(goal_id, started_at, status, steps) VALUES(?,?,?,0)').run(goalId, now(), 'running');
  return Number(info.lastInsertRowid);
}
export function finishRun(id, status, summary, steps) {
  db.prepare('UPDATE runs SET ended_at = ?, status = ?, summary = ?, steps = ? WHERE id = ?').run(now(), status, summary || '', steps || 0, id);
}
export function listRuns(goalId = null, limit = 20) {
  if (goalId) return db.prepare('SELECT * FROM runs WHERE goal_id = ? ORDER BY id DESC LIMIT ?').all(goalId, limit);
  return db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit);
}

export function addEvent(type, text = '', data = null) {
  const t = now();
  const info = db.prepare('INSERT INTO events(type, text, data, created_at) VALUES(?,?,?,?)').run(type, text, J(data), t);
  db.prepare('DELETE FROM events WHERE id < (SELECT MAX(id) FROM events) - 800').run();
  return { id: Number(info.lastInsertRowid), type, text, data, created_at: t };
}
export function listEvents(limit = 100) {
  return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit).reverse().map((e) => ({ ...e, data: P(e.data) }));
}

export function stats() {
  return {
    messages: db.prepare('SELECT COUNT(*) AS c FROM messages').get().c,
    memories: db.prepare('SELECT COUNT(*) AS c FROM memories').get().c,
    goals: db.prepare('SELECT COUNT(*) AS c FROM goals').get().c,
    runs: db.prepare('SELECT COUNT(*) AS c FROM runs').get().c,
    dbBytes: fs.existsSync(path.join(DATA_DIR, 'jarvis.db')) ? fs.statSync(path.join(DATA_DIR, 'jarvis.db')).size : 0
  };
}

function archiveOld() {
  const cutoff = now() - 1000 * 60 * 60 * 24 * 120;
  db.prepare('DELETE FROM messages WHERE created_at < ? AND session_id NOT IN (SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 10)').run(cutoff);
}
