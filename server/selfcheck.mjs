import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, workspaceDir } from './config.mjs';
import * as store from './store.mjs';
import { executeTool, stripHtml } from './tools.mjs';
import { loadSkills, listSkills } from './skills.mjs';
import { Telegram, safeAttachmentName } from './telegram.mjs';
import { parseCompletion } from './llm.mjs';

const cfg = loadConfig();
const ctx = { cfg, mcp: null, telegram: null, emit: () => {} };
const ws = workspaceDir(cfg);
const file = path.join(ws, '.jarvis-selfcheck.txt');

assert.ok(stripHtml('<b>Hello</b> <script>ignore()</script> world').includes('Hello world'), 'stripHtml keeps text and drops script');

const memId = store.addMemory('Selfcheck: the answer is aurora-42', 'fact', 'selfcheck,test');
const found = store.searchMemories('aurora-42 selfcheck', 5);
assert.ok(found.some((m) => m.id === memId), 'memory search finds a saved fact');
store.deleteMemory(memId);

const goal = store.createGoal({ title: 'Selfcheck mission', detail: 'assert lifecycle' });
assert.equal(goal.status, 'active');
store.updateGoal(goal.id, { progress: 42, note: 'halfway' });
assert.equal(store.getGoal(goal.id).progress, 42);
assert.ok(store.nextDueGoal(Date.now() + 1000), 'active goal is due');
store.deleteGoal(goal.id);

const remindOut = await executeTool('remind', { text: 'Selfcheck reminder', inMinutes: 1 }, ctx);
assert.ok(remindOut.includes('Reminder #'), 'remind creates a reminder');
const reminder = store.listReminders(50).find((r) => r.text === 'Selfcheck reminder');
assert.ok(reminder, 'reminder is pending');
assert.ok((await executeTool('reminder_list', {}, ctx)).includes('Selfcheck reminder'), 'reminder_list shows it');
assert.ok((await executeTool('reminder_cancel', { id: reminder.id }, ctx)).includes('cancelled'), 'reminder_cancel cancels it');
store.deleteReminder(reminder.id);
const repeat = store.createReminder({ text: 'Selfcheck repeat', dueAt: Date.now() - 1000, repeatSec: 60 });
assert.ok(store.dueReminders().some((r) => r.id === repeat.id), 'due reminder is found');
store.fireReminder(repeat.id);
assert.ok(store.getReminder(repeat.id).due_at > Date.now(), 'recurring reminder schedules its next run');
store.deleteReminder(repeat.id);

await executeTool('write_file', { path: '.jarvis-selfcheck.txt', content: 'alpha\nbeta\n' }, ctx);
assert.ok(fs.existsSync(file), 'write_file creates the file');
const read = await executeTool('read_file', { path: '.jarvis-selfcheck.txt' }, ctx);
assert.ok(read.includes('alpha'), 'read_file returns content');
await executeTool('edit_file', { path: '.jarvis-selfcheck.txt', old_string: 'beta', new_string: 'gamma' }, ctx);
assert.ok(fs.readFileSync(file, 'utf8').includes('gamma'), 'edit_file replaces text');
const listed = await executeTool('list_files', { pattern: '**/.jarvis-selfcheck.txt' }, ctx);
assert.ok(listed.includes('.jarvis-selfcheck.txt'), 'list_files globs recursively');
const blocked = await executeTool('read_file', { path: 'secrets/model_key.txt' }, ctx);
assert.ok(blocked.startsWith('ERROR:'), 'secrets are blocked');
const escaped = await executeTool('read_file', { path: path.join(ws, '..', 'outside-selfcheck.txt') }, ctx);
assert.ok(escaped.startsWith('ERROR:'), 'paths outside the workspace are blocked');
fs.writeFileSync(file, '# Selfcheck document\n\nAurora-42.\n');
assert.ok((await executeTool('read_document', { path: '.jarvis-selfcheck.txt' }, ctx)).includes('Aurora-42'), 'read_document reads text files');
assert.ok((await executeTool('google', { action: 'status' }, ctx)).startsWith('Google:'), 'google reports connection status');
const blockedHttp = await executeTool('http_request', { url: 'https://not-allowlisted.invalid/' }, ctx);
assert.ok(blockedHttp.includes('not allowlisted'), 'http_request refuses non-allowlisted hosts');

const shellOut = await executeTool('shell', { command: 'node --version' }, ctx);
if (shellOut.includes('not allowed') || shellOut.includes('disabled')) console.log('selfcheck: shell allowlist active (node not allowed)');
else if (shellOut.includes('EPERM')) console.log('selfcheck: shell skipped (sandbox blocks child pipe stdio)');
else assert.ok(/v\d+\./.test(shellOut), 'shell runs an allowlisted command');
fs.unlinkSync(file);

const tg = new Telegram({ telegram: { enabled: false, updateMinutes: 60, voiceReplies: true, chatId: '' } }, { emit: () => {} });
tg.lastVoiceAt = 0;
assert.equal(tg.voiceDue(60000), false, 'voice notes wait for the update interval');
assert.equal(tg.voiceDue(60 * 60000), true, 'voice notes become due after the update interval');
assert.equal(safeAttachmentName('../../report.PDF', 'application/pdf'), 'report.pdf', 'attachment names are sanitized');
assert.equal(safeAttachmentName('', 'image/jpeg', '.jpg'), 'file.jpg', 'photo fallback names work');
assert.throws(() => safeAttachmentName('run.exe', 'application/octet-stream'), /Unsupported attachment/, 'unsafe attachments are refused');
assert.equal(parseCompletion('{"choices":[{"message":{"content":"ok"}}]}').choices[0].message.content, 'ok', 'plain completion JSON parses');
assert.equal(parseCompletion('{"choices":[{"message":{"content":"ok"}}]}data: [DONE]\n\n').choices[0].message.content, 'ok', 'proxy JSON with SSE trailer parses');
assert.equal(parseCompletion('data: {"choices":[{"message":{"content":"ok"}}]}\n\ndata: [DONE]\n\n').choices[0].message.content, 'ok', 'SSE completion parses');
assert.equal(parseCompletion('data: {"choices":[{"delta":{"content":"A"}}]}\ndata: {"choices":[{"delta":{"content":"B"}}]}\ndata: [DONE]\n').choices[0].message.content, 'AB', 'SSE deltas join');

loadSkills();
assert.ok(listSkills().length >= 2, 'skills load from skills/');

console.log('selfcheck ok — memory, goals, reminders, files, shell, skills, integrations');
