const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  config: null,
  agent: { mode: 'idle', goals: [], mcp: [], skills: [], telegram: { state: 'off' }, uptime: 0 },
  goals: [],
  memories: [],
  skills: [],
  mcp: [],
  sessions: [],
  sessionId: null,
  view: 'chat',
  streaming: null,
  toolChips: new Map(),
  lastAssistant: '',
  activities: [],
  wake: false,
  speak: true,
  listening: false,
  speaking: false,
  rec: null,
  recMode: 'command',
  armedUntil: 0,
  voiceSupported: false
};

const VIEW_META = {
  chat: ['Command', 'LOCAL COMMAND INTELLIGENCE'],
  missions: ['Missions', 'AUTONOMOUS GOALS'],
  memory: ['Memory', 'LONG-TERM CONTEXT'],
  skills: ['Skills', 'PROCEDURAL KNOWLEDGE'],
  mcp: ['MCP Servers', 'EXTERNAL TOOLS'],
  settings: ['Settings', 'SYSTEM CONFIGURATION']
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[c]));
}

function renderMarkdown(text) {
  const parts = String(text ?? '').split('```');
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      const body = part.replace(/^[a-zA-Z0-9_+-]*\n/, '');
      return '<pre><code>' + escapeHtml(body) + '</code></pre>';
    }
    let html = escapeHtml(part);
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    html = html.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
    html = html.replace(/\n/g, '<br>');
    return html;
  }).join('');
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch { data = { ok: false, error: 'Invalid response' }; }
  if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

function scrollBottom(force = false) {
  const el = $('#messages');
  if (!el) return;
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 180;
  if (force || near) el.scrollTop = el.scrollHeight;
}

function timeOf(ts) {
  try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

function whenIn(ts) {
  if (!ts) return '—';
  const diff = Number(ts) - Date.now();
  if (diff <= 0) return 'due now';
  const mins = Math.ceil(diff / 60000);
  if (mins < 60) return 'in ' + mins + 'm';
  return 'in ' + Math.round(mins / 60) + 'h';
}

async function loadBootstrap() {
  const data = await api('/api/bootstrap');
  state.config = data.config;
  state.agent = data.state;
  state.goals = data.state.goals || [];
  state.memories = data.memories || [];
  state.skills = data.state.skills || [];
  state.mcp = data.state.mcp || [];
  state.sessions = data.sessions || [];
  state.sessionId = data.state.sessionId;
  state.speak = Boolean(data.config.voice?.autoSpeak);
  state.wake = false;
  renderSessions();
  renderMessages(data.messages || []);
  hydrateSettings();
  renderAll();
  seedActivity(data.events || []);
  return data;
}

function renderSessions() {
  const sel = $('#sessionSelect');
  if (!sel) return;
  sel.innerHTML = state.sessions.map((s) => {
    const label = (s.title || 'Thread') + ' · ' + new Date(s.updated_at).toLocaleDateString();
    return '<option value="' + s.id + '"' + (s.id === state.sessionId ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
  }).join('') || '<option>Thread</option>';
}

function emptyChatHtml() {
  return [
    '<div class="empty-chat">',
    '  <div class="glyph">J</div>',
    '  <h2>At your service.</h2>',
    '  <p>I can build, research, operate this machine, run missions while you sleep, and report on Telegram. Speak or type — I will act.</p>',
    '  <div class="suggestions">',
    '    <button class="suggestion" data-prompt="Give me a tour of this workspace and tell me what you can do with it.">Tour this workspace</button>',
    '    <button class="suggestion" data-prompt="Research the most useful MCP servers for coding and set up the best one.">Set up an MCP server</button>',
    '    <button class="suggestion" data-prompt="Create a mission to audit this project, fix one real issue, and report back.">Start a mission</button>',
    '    <button class="suggestion" data-prompt="What do you remember about me and my projects?">Recall memory</button>',
    '  </div>',
    '</div>'
  ].join('');
}

function renderMessages(messages) {
  const el = $('#messages');
  el.innerHTML = '';
  if (!messages.length) { el.innerHTML = emptyChatHtml(); return; }
  for (const m of messages) appendMessage(m, false);
  scrollBottom(true);
}

function appendMessage(message, animate = true) {
  if (!message || message.hidden) return;
  if (message.role === 'tool') return;
  if (message.role === 'assistant' && !String(message.content || '').trim()) return;
  const el = $('#messages');
  const empty = $('.empty-chat', el);
  if (empty) el.innerHTML = '';
  const isUser = message.role === 'user';
  const source = message.source === 'telegram' ? ' via telegram' : '';
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (isUser ? 'user' : 'jarvis') + (message.source === 'telegram' ? ' telegram' : '');
  if (!animate) wrap.style.animation = 'none';
  wrap.innerHTML = [
    isUser ? '' : '<div class="avatar">J</div>',
    '<div class="msg-body">',
    '  <div class="msg-meta"><b>' + (isUser ? 'You' : 'Jarvis') + source + '</b><span>' + timeOf(message.created_at) + '</span></div>',
    '  <div class="bubble">' + renderMarkdown(message.content) + '</div>',
    '</div>'
  ].join('');
  el.appendChild(wrap);
  if (animate) scrollBottom();
}

function ensureStream() {
  if (state.streaming) return state.streaming;
  const el = $('#messages');
  const empty = $('.empty-chat', el);
  if (empty) el.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'msg jarvis streaming';
  wrap.innerHTML = '<div class="avatar">J</div><div class="msg-body"><div class="msg-meta"><b>Jarvis</b><span>now</span></div><div class="bubble"></div></div>';
  el.appendChild(wrap);
  state.streaming = $('.bubble', wrap);
  scrollBottom();
  return state.streaming;
}

function finalizeStream(content) {
  if (!state.streaming) return false;
  const bubble = state.streaming;
  const wrap = bubble.closest('.msg');
  if (String(content || '').trim()) bubble.innerHTML = renderMarkdown(content);
  else wrap.remove();
  wrap.classList.remove('streaming');
  state.streaming = null;
  mediaScroll();
  return true;
}

function mediaScroll() { scrollBottom(); }

function addToolChip(event) {
  const el = $('#messages');
  const empty = $('.empty-chat', el);
  if (empty) el.innerHTML = '';
  const chip = document.createElement('div');
  chip.className = 'tool-chip';
  chip.innerHTML = '<span class="gear"></span><b>' + escapeHtml(event.name || 'tool') + '</b><span class="preview">' + escapeHtml(argsPreview(event.args)) + '</span>';
  el.appendChild(chip);
  state.toolChips.set(event.id || String(Date.now() + Math.random()), chip);
  scrollBottom();
}

function argsPreview(args) {
  if (!args || typeof args !== 'object') return '';
  const first = Object.entries(args)[0];
  if (!first) return '';
  const value = typeof first[1] === 'string' ? first[1] : JSON.stringify(first[1]);
  return String(value).replace(/\s+/g, ' ').slice(0, 110);
}

function finishToolChip(event) {
  const chip = state.toolChips.get(event.id);
  if (!chip) return;
  chip.classList.add(event.ok ? 'done' : 'fail');
  const gear = $('.gear', chip);
  if (gear) gear.textContent = event.ok ? '✓' : '✗';
  const preview = $('.preview', chip);
  if (preview) preview.textContent = String(event.preview || '').replace(/\s+/g, ' ').slice(0, 130);
  chip.title = event.preview || '';
  mediaScroll();
}

function seedActivity(events) {
  state.activities = events.slice(-30).map((e) => ({ at: e.created_at, type: e.type, text: e.text || e.type }));
  renderActivity();
}

function pushActivity(type, text) {
  state.activities.push({ at: Date.now(), type, text: String(text || '') });
  if (state.activities.length > 40) state.activities.shift();
  renderActivity();
}

function renderActivity() {
  const el = $('#activity');
  if (!el) return;
  if (!state.activities.length) { el.innerHTML = '<div class="activity-empty">Waiting for events…</div>'; return; }
  el.innerHTML = state.activities.slice(-16).map((a) => {
    const cls = ['error', 'tool', 'goal'].includes(a.type) ? a.type : '';
    return '<div class="activity-item ' + cls + '"><span class="activity-time">' + timeOf(a.at) + '</span><span><b>' + escapeHtml(a.type) + '</b> ' + escapeHtml(a.text) + '</span></div>';
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function renderHud() {
  const a = state.agent || {};
  const busy = a.mode === 'working' || a.running;
  const pill = $('#statusPill');
  pill.classList.toggle('busy', Boolean(busy));
  $('#statusText').textContent = state.listening ? 'Listening' : busy ? 'Working' : 'Standby';
  const orb = $('#orb');
  if (orb) {
    orb.classList.toggle('working', Boolean(busy) && !state.listening && !state.speaking);
    orb.classList.toggle('listening', state.listening);
    orb.classList.toggle('speaking', state.speaking);
  }
  const hudState = $('#hudState');
  if (hudState) hudState.textContent = state.listening ? 'LISTENING' : state.speaking ? 'SPEAKING' : busy ? 'WORKING' : 'STANDBY';
  const hudDetail = $('#hudDetail');
  if (hudDetail) hudDetail.textContent = a.detail || 'All systems nominal';
  const model = state.config?.model?.model || '—';
  $('#telModel').textContent = model;
  $('#telModel').title = model;
  $('#telSkills').textContent = (state.skills || []).length;
  $('#telMcp').textContent = (state.mcp || []).filter((m) => m.state === 'ready').length + '/' + (state.mcp || []).length;
  $('#telQueue').textContent = a.queued || 0;
  $('#telTokens').textContent = (a.tokens || 0).toLocaleString();
  $('#telUptime').textContent = Math.floor((a.uptime || 0) / 60) + 'm';
  const input = $('#input');
  if (input) input.placeholder = busy ? 'Steer Jarvis while it works — it reads this at its next step…' : 'Tell Jarvis what to do…';
  const note = $('#composerNote');
  if (note) {
    const queued = a.queued || 0;
    note.textContent = queued
      ? queued + ' message' + (queued === 1 ? '' : 's') + ' queued — Jarvis sees them between steps'
      : busy ? 'Working — type to steer'
      : state.config && !state.config.model.configured ? 'No model key — add one in Settings' : '';
  }
  const tg = a.telegram || { state: 'off' };
  const tgOn = tg.state === 'polling' || tg.state === 'idle';
  $('#tgDot').classList.toggle('on', tgOn);
  $('#telegramFoot').textContent = tgOn ? (tg.paired ? 'Telegram paired · ' + (tg.bot || '') : 'Telegram online · not paired') : 'Telegram ' + (tg.state || 'offline');
  const active = (state.goals || []).find((g) => g.status === 'active');
  const box = $('#hudMission');
  if (!active) {
    box.className = 'mission-empty';
    box.innerHTML = 'No active mission.<br>Deploy one to let Jarvis work while you are away.';
    $('#missionSignal').style.opacity = '0.25';
  } else {
    box.className = '';
    $('#missionSignal').style.opacity = '1';
    box.innerHTML = [
      '<div class="mission-name">#' + active.id + ' · ' + escapeHtml(active.title) + '</div>',
      '<div class="progress"><i style="width:' + (active.progress || 0) + '%"></i></div>',
      '<div class="mission-foot"><span>' + (active.progress || 0) + '%</span><span id="missionNext">' + whenIn(active.next_wake) + '</span></div>',
      active.note ? '<div class="mission-note">' + escapeHtml(String(active.note).slice(0, 150)) + '</div>' : ''
    ].join('');
  }
}

function renderAll() {
  renderHud();
  renderGoals();
  renderReminders();
  renderMemories();
  renderSkills();
  renderMcp();
  renderSystem();
  updateVoiceUi();
}

function handleEvent(event) {
  switch (event.type) {
    case 'state': {
      state.agent = event;
      state.goals = event.goals || state.goals;
      state.skills = event.skills || state.skills;
      state.mcp = event.mcp || state.mcp;
      renderHud();
      if (state.view === 'missions') { renderGoals(); renderReminders(); }
      if (state.view === 'mcp') renderMcp();
      if (state.view === 'skills') renderSkills();
      break;
    }
    case 'message': {
      const m = event.message;
      if (!m || m.hidden || m.role === 'tool') break;
      if (m.role === 'assistant') {
        if (String(m.content || '').trim()) {
          state.lastAssistant = m.content;
          if (!finalizeStream(m.content)) appendMessage(m);
        } else if (m.tool_calls?.length) {
          finalizeStream('');
        }
      } else {
        appendMessage(m);
      }
      break;
    }
    case 'delta':
      if (event.text) {
        const bubble = ensureStream();
        bubble.textContent += event.text;
        scrollBottom();
      }
      break;
    case 'tool_start': addToolChip(event); break;
    case 'tool_end': finishToolChip(event); break;
    case 'turn_start': state.lastAssistant = ''; break;
    case 'turn_end':
      finalizeStream('');
      if (state.speak && state.lastAssistant) speak(state.lastAssistant);
      state.lastAssistant = '';
      break;
    case 'reminder': {
      if (event.action === 'fired') {
        toast(event.text);
        pushActivity('goal', event.text);
        if (state.speak) speak(event.text);
        if (event.reminder && !event.reminder.repeat_sec) state.agent.reminders = (state.agent.reminders || []).filter((r) => r.id !== event.reminder.id);
      } else if (event.action === 'created' && event.reminder) {
        toast(event.text);
        const list = (state.agent.reminders || []).filter((r) => r.id !== event.reminder.id);
        list.push(event.reminder);
        list.sort((a, b) => a.due_at - b.due_at);
        state.agent.reminders = list;
      } else if (event.action === 'cancelled') {
        state.agent.reminders = (state.agent.reminders || []).filter((r) => r.id !== event.id);
      }
      renderReminders();
      break;
    }
    case 'goal':
      if (event.id) {
        const idx = state.goals.findIndex((g) => g.id === event.id);
        if (idx >= 0) state.goals[idx] = event; else state.goals.unshift(event);
      } else {
        loadBootstrap().catch(() => {});
      }
      renderGoals();
      renderHud();
      break;
    case 'mcp':
      state.mcp = event.servers || state.mcp;
      state.agent.mcp = state.mcp;
      renderHud();
      renderMcp();
      break;
    case 'telegram':
      state.agent.telegram = event;
      renderHud();
      break;
    case 'log':
      pushActivity(event.level === 'error' ? 'error' : 'tool', event.text);
      if (event.level === 'error') toast(event.text, true);
      break;
    case 'error': toast(event.text || 'Something went wrong', true); break;
    case 'queued':
      $('#composerNote').textContent = event.queued > 1 ? event.queued + ' messages queued' : '';
      break;
    case 'steer':
      toast('Steering applied — Jarvis will adjust at the next step');
      break;
    case 'memory':
      pushActivity('goal', event.action === 'compacted' ? 'Context compacted' : 'Memory updated');
      refreshMemories().catch(() => {});
      break;
    case 'session':
      if (event.id !== state.sessionId) loadBootstrap().catch(() => {});
      break;
  }
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    try { handleEvent(JSON.parse(e.data)); } catch (err) { console.error(err); }
  };
  es.onopen = () => {
    if (state.sseDown) { state.sseDown = false; pushActivity('tool', 'Event stream restored'); }
  };
  es.onerror = () => {
    if (!state.sseDown) { state.sseDown = true; pushActivity('error', 'Event stream lost — retrying'); }
  };
}

function renderGoals() {
  const el = $('#goalList');
  if (!el) return;
  if (!state.goals.length) {
    el.innerHTML = '<div class="empty-state">No missions yet. Deploy one above and Jarvis will start working on its own schedule.</div>';
    return;
  }
  el.innerHTML = state.goals.map((g) => {
    const status = g.status || 'active';
    const label = status === 'active' ? 'RUNNING' : status === 'paused' ? 'PAUSED' : 'DONE';
    return [
      '<div class="goal ' + status + '" data-id="' + g.id + '">',
      '  <div>',
      '    <div class="goal-title"><span class="goal-id">#' + g.id + '</span><h3>' + escapeHtml(g.title) + '</h3><span class="tag ' + (status === 'active' ? '' : status === 'paused' ? 'warn' : '') + '">' + label + '</span></div>',
      g.detail ? '    <p class="goal-detail">' + escapeHtml(String(g.detail).slice(0, 280)) + '</p>' : '',
      '    <div class="progress"><i style="width:' + (g.progress || 0) + '%"></i></div>',
      '    <div class="goal-meta"><span>' + (g.progress || 0) + '%</span><span>' + (g.iterations || 0) + ' wake-ups</span><span>next ' + whenIn(g.next_wake) + '</span><span>updated ' + timeOf(g.updated_at) + '</span></div>',
      g.note ? '    <p class="goal-note">' + escapeHtml(String(g.note).slice(0, 240)) + '</p>' : '',
      '  </div>',
      '  <div class="goal-actions">',
      status === 'active' ? '    <button class="mini" data-act="pause" data-id="' + g.id + '">pause</button>' : '',
      status !== 'active' && status !== 'done' ? '    <button class="mini" data-act="resume" data-id="' + g.id + '">resume</button>' : '',
      status !== 'done' ? '    <button class="mini" data-act="done" data-id="' + g.id + '">complete</button>' : '',
      '    <button class="mini" data-act="delete" data-id="' + g.id + '">delete</button>',
      '  </div>',
      '</div>'
    ].filter(Boolean).join('');
  }).join('');
}

function repeatEvery(sec) {
  const days = sec / 86400;
  const hours = sec / 3600;
  if (days >= 1) return 'every ' + (Number.isInteger(days) ? days : days.toFixed(1)) + 'd';
  if (hours >= 1) return 'every ' + (Number.isInteger(hours) ? hours : hours.toFixed(1)) + 'h';
  return 'every ' + Math.round(sec / 60) + 'm';
}

function renderReminders() {
  const el = $('#reminderList');
  if (!el) return;
  const rows = state.agent?.reminders || [];
  $('#reminderCount').textContent = rows.length;
  if (!rows.length) {
    el.innerHTML = '<div class="empty-state">No reminders. Ask Jarvis to set one in chat.</div>';
    return;
  }
  el.innerHTML = rows.map((r) => {
    const when = new Date(r.due_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return [
      '<div class="goal reminder" data-id="' + r.id + '">',
      '  <div>',
      '    <div class="goal-title"><span class="goal-id">#' + r.id + '</span><h3>' + escapeHtml(r.text) + '</h3><span class="tag">' + whenIn(r.due_at) + '</span></div>',
      '    <div class="goal-meta"><span>' + when + '</span>' + (r.repeat_sec ? '<span>' + repeatEvery(r.repeat_sec) + '</span>' : '') + '</div>',
      '  </div>',
      '  <div class="goal-actions"><button class="mini" data-reminder-cancel="' + r.id + '">cancel</button></div>',
      '</div>'
    ].join('');
  }).join('');
}

function renderMemories() {
  const el = $('#memoryList');
  if (!el) return;
  const q = ($('#memorySearch')?.value || '').toLowerCase().trim();
  const rows = state.memories.filter((m) => !q || (m.text + ' ' + (m.tags || '')).toLowerCase().includes(q));
  $('#memoryCount').textContent = state.memories.length;
  if (!rows.length) { el.innerHTML = '<div class="empty-state">' + (q ? 'Nothing matches that search.' : 'No memories yet. Jarvis stores durable facts as it works, or add one above.') + '</div>'; return; }
  el.innerHTML = rows.map((m) => [
    '<div class="memory-item">',
    '  <span class="memory-kind">' + escapeHtml(m.kind) + '</span>',
    '  <span class="memory-text">' + escapeHtml(m.text) + (m.tags ? '<span class="memory-tags">' + escapeHtml(m.tags) + '</span>' : '') + '</span>',
    '  <button class="text-btn" data-memory="' + m.id + '" title="Forget">forget</button>',
    '</div>'
  ].join('')).join('');
}

async function refreshMemories() {
  const data = await api('/api/memories');
  state.memories = data.memories || [];
  renderMemories();
}

function renderSkills() {
  const el = $('#skillList');
  if (!el) return;
  if (!state.skills.length) { el.innerHTML = '<div class="empty-state">No skills installed. Create skills/&lt;name&gt;/SKILL.md and press reload.</div>'; return; }
  el.innerHTML = state.skills.map((s) => [
    '<div class="skill-card" data-skill="' + escapeHtml(s.name) + '">',
    '  <h3>' + escapeHtml(s.name) + '</h3>',
    '  <p>' + escapeHtml(s.description || 'No description') + '</p>',
    '  <div class="skill-body"><pre class="skill-code">Loading…</pre></div>',
    '</div>'
  ].join('')).join('');
}

function renderMcp() {
  const el = $('#mcpList');
  if (!el) return;
  const conf = state.config?.mcpServers || {};
  if (!state.mcp.length) {
    el.innerHTML = '<div class="empty-state">No MCP servers configured. Add one above to give Jarvis new tools.</div>';
    return;
  }
  el.innerHTML = state.mcp.map((s) => {
    const c = conf[s.name] || {};
    const detail = c.url ? c.url : [c.command, ...(c.args || [])].filter(Boolean).join(' ');
    const tools = s.tools ? s.tools + ' tools' : (s.state === 'ready' ? 'connected' : s.state);
    return [
      '<div class="mcp-row">',
      '  <span class="state ' + escapeHtml(s.state) + '"></span>',
      '  <div><div class="mcp-name">' + escapeHtml(s.name) + '</div><div class="mcp-meta">' + escapeHtml(String(detail).slice(0, 110)) + (s.error ? ' · ' + escapeHtml(s.error) : '') + '</div></div>',
      '  <span class="spacer"></span>',
      '  <span class="mcp-tools">' + escapeHtml(tools) + '</span>',
      '  <button class="mini" data-mcp-restart="' + escapeHtml(s.name) + '">restart</button>',
      '  <button class="mini" data-mcp-remove="' + escapeHtml(s.name) + '">remove</button>',
      '</div>'
    ].join('');
  }).join('');
}

function renderSystem() {
  const c = state.config;
  if (!c) return;
  $('#sysWorkspace').textContent = c.paths?.workspace || '—';
  $('#sysConfig').textContent = c.paths?.configFile || '—';
  $('#sysCommands').textContent = (c.safety.allowedCommands || []).length;
  $('#sysMcp').textContent = (state.mcp || []).length;
  $('#sysSkills').textContent = (state.skills || []).length;
}

function hydrateSettings() {
  const c = state.config;
  if (!c) return;
  const val = (sel, v) => { const el = $(sel); if (el) el.value = v ?? ''; };
  val('#cfgBaseUrl', c.model.baseUrl);
  val('#cfgModel', c.model.model);
  val('#cfgTemp', c.model.temperature);
  val('#cfgMaxTokens', c.model.maxTokens);
  val('#cfgContext', c.model.contextMessages);
  val('#cfgCompact', c.model.compactAfter);
  val('#cfgInterval', c.agent.autonomyIntervalSec);
  val('#cfgSteps', c.agent.maxStepsPerTurn);
  val('#cfgMaxRuns', c.agent.maxGoalRuns);
  val('#cfgUser', c.user);
  val('#cfgWorkspace', c.safety.workspace);
  val('#cfgAllowed', (c.safety.allowedCommands || []).join('\n'));
  val('#cfgTgMinutes', c.telegram.updateMinutes);
  val('#cfgWakeWord', c.voice.wakeWord);
  $('#cfgAutopilot').checked = Boolean(c.agent.autopilot);
  $('#cfgShell').checked = Boolean(c.safety.allowShell);
  $('#cfgTgEnabled').checked = Boolean(c.telegram.enabled);
  $('#cfgTgVoice').checked = Boolean(c.telegram.voiceReplies);
  $('#cfgAutoSpeak').checked = Boolean(c.voice.autoSpeak);
  $('#speakToggle').checked = state.speak;
  $('#wakeWord').textContent = c.voice.wakeWord || 'jarvis';
  $('#keyPath').textContent = c.paths?.keyFile || 'secrets/model_key.txt';
  $('#keyStatus').textContent = c.secrets.modelKey ? 'stored' : 'missing';
  $('#keyStatus').className = 'tag ' + (c.secrets.modelKey ? '' : 'warn');
  $('#modelConfigured').textContent = c.model.configured ? 'ready' : 'no key';
  $('#modelConfigured').className = 'tag ' + (c.model.configured ? '' : 'warn');
  const tg = state.agent.telegram || {};
  $('#tgState').textContent = tg.state || 'offline';
  $('#tgState').className = 'tag ' + (tg.state === 'polling' || tg.state === 'idle' ? '' : 'warn');
  $('#tgPairCode').value = tg.pairCode || '—';
  $('#tgPairHint').innerHTML = tg.paired ? 'Paired with chat ' + escapeHtml(tg.chatId || '') + '. Reply on Telegram any time to steer.' : 'On your phone, open the bot and send <code>/pair ' + escapeHtml(tg.pairCode || '______') + '</code>';
  $('#composerNote').textContent = c.model.configured ? '' : 'No model key — add one in Settings';
  renderSystem();
}

async function saveSettings() {
  const fallback = state.config || { model: {}, agent: {}, telegram: {} };
  const num = (sel, def, min = 0) => {
    const n = Number($(sel).value);
    return Number.isFinite(n) && n >= min ? n : def;
  };
  const baseUrl = $('#cfgBaseUrl').value.trim();
  const modelName = $('#cfgModel').value.trim();
  const workspace = $('#cfgWorkspace').value.trim();
  if (!baseUrl || !modelName || !workspace) return toast('Base URL, model name and workspace are required', true);
  const patch = {
    user: $('#cfgUser').value.trim() || 'Sir',
    model: {
      baseUrl,
      model: modelName,
      temperature: Math.max(0, Math.min(2, num('#cfgTemp', fallback.model.temperature ?? 0.6))),
      maxTokens: num('#cfgMaxTokens', fallback.model.maxTokens ?? 4096, 64),
      contextMessages: num('#cfgContext', fallback.model.contextMessages ?? 40, 6),
      compactAfter: num('#cfgCompact', fallback.model.compactAfter ?? 60, 20)
    },
    agent: {
      autopilot: $('#cfgAutopilot').checked,
      autonomyIntervalSec: num('#cfgInterval', fallback.agent.autonomyIntervalSec ?? 180, 30),
      maxStepsPerTurn: num('#cfgSteps', fallback.agent.maxStepsPerTurn ?? 30, 1),
      maxGoalRuns: num('#cfgMaxRuns', fallback.agent.maxGoalRuns ?? 200, 1)
    },
    telegram: { enabled: $('#cfgTgEnabled').checked, updateMinutes: num('#cfgTgMinutes', fallback.telegram.updateMinutes ?? 3, 0), voiceReplies: $('#cfgTgVoice').checked },
    voice: { wakeWord: $('#cfgWakeWord').value.trim() || 'jarvis', autoSpeak: $('#cfgAutoSpeak').checked },
    safety: {
      workspace,
      allowShell: $('#cfgShell').checked,
      allowedCommands: $('#cfgAllowed').value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
    }
  };
  try {
    const res = await api('/api/config', { method: 'POST', body: patch });
    state.config = res.config;
    state.speak = Boolean(res.config.voice.autoSpeak);
    hydrateSettings();
    renderHud();
    toast('Settings saved');
    $('#saveHint').textContent = 'saved ' + new Date().toLocaleTimeString();
  } catch (err) { toast(err.message, true); }
}

async function saveModelKey() {
  const value = $('#secretModelKey').value.trim();
  if (!value) return toast('Paste a key first, or drop one at ' + (state.config?.paths?.keyFile || 'secrets/model_key.txt'), true);
  try {
    const res = await api('/api/secrets', { method: 'POST', body: { modelKey: value } });
    state.config = res.config;
    $('#secretModelKey').value = '';
    hydrateSettings();
    toast('Model key saved');
  } catch (err) { toast(err.message, true); }
}

async function saveTelegram() {
  const token = $('#secretTelegram').value.trim();
  try {
    await api('/api/config', { method: 'POST', body: { telegram: { enabled: $('#cfgTgEnabled').checked, updateMinutes: Number($('#cfgTgMinutes').value), voiceReplies: $('#cfgTgVoice').checked } } });
    if (token) {
      const res = await api('/api/secrets', { method: 'POST', body: { telegramToken: token } });
      state.config = res.config;
      $('#secretTelegram').value = '';
    }
    const boot = await api('/api/bootstrap');
    state.config = boot.config;
    state.agent = boot.state;
    hydrateSettings();
    renderHud();
    toast(token ? 'Telegram token saved — connecting' : 'Telegram settings saved');
  } catch (err) { toast(err.message, true); }
}

async function refreshMcp() {
  try {
    const data = await api('/api/mcp');
    state.mcp = data.servers || [];
    renderMcp();
    renderHud();
  } catch (err) { toast(err.message, true); }
}

function updateVoiceUi() {
  const mic = $('#micBtn');
  const rail = $('#railVoice');
  if (!mic) return;
  mic.disabled = !state.voiceSupported;
  mic.title = state.voiceSupported ? 'Push to talk' : 'Speech recognition needs Chrome or Edge';
  mic.classList.toggle('live', state.listening && state.recMode === 'command');
  rail.classList.toggle('live', state.listening);
  $('#wakeToggle').checked = state.wake;
  $('#speakToggle').checked = state.speak;
  const word = state.config?.voice?.wakeWord || 'jarvis';
  $('#wakeWord').textContent = word;
  if (!state.listening) $('#voiceState').textContent = '';
}

function initVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    state.voiceSupported = false;
    updateVoiceUi();
    return;
  }
  state.voiceSupported = true;
  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  rec.onstart = () => { state.listening = true; updateVoiceUi(); renderHud(); };
  rec.onend = () => {
    const restart = state.wake && state.recMode === 'wake';
    state.listening = false;
    updateVoiceUi();
    renderHud();
    if (restart) setTimeout(() => { if (state.wake && state.recMode === 'wake' && !state.listening) startRecognition('wake'); }, 500);
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      state.wake = false;
      toast('Microphone permission was denied', true);
    } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
      toast('Speech error: ' + e.error, true);
    }
    updateVoiceUi();
  };
  rec.onresult = onSpeech;
  state.rec = rec;
  updateVoiceUi();
}

function onSpeech(event) {
  let finalText = '';
  let interim = '';
  for (let i = event.resultIndex; i < event.results.length; i++) {
    const piece = event.results[i][0]?.transcript || '';
    if (event.results[i].isFinal) finalText += piece + ' ';
    else interim += piece + ' ';
  }
  if (interim.trim()) $('#voiceState').textContent = '“' + interim.trim().slice(0, 70) + '”';
  const text = finalText.trim();
  if (!text) return;
  $('#voiceState').textContent = '';
  if (state.recMode === 'wake') handleWakePhrase(text);
  else {
    stopRecognition();
    sendMessage(text);
  }
}

function handleWakePhrase(text) {
  const word = (state.config?.voice?.wakeWord || 'jarvis').toLowerCase();
  const lower = text.toLowerCase();
  const idx = lower.indexOf(word);
  if (idx >= 0) {
    const command = text.slice(idx + word.length).replace(/^[\s,.:;!?-]+/, '').trim();
    if (command) { beep(1040); sendMessage(command); }
    else {
      state.armedUntil = Date.now() + 9000;
      beep(880);
      speak('Yes?');
      $('#voiceState').textContent = 'Listening…';
    }
    return;
  }
  if (Date.now() < state.armedUntil) {
    state.armedUntil = 0;
    sendMessage(text);
  }
}

function startRecognition(mode) {
  if (!state.rec) { toast('Speech recognition needs Chrome or Edge', true); return; }
  if (state.listening && state.recMode !== mode) stopRecognition();
  state.recMode = mode;
  state.rec.continuous = mode === 'wake';
  try { state.rec.start(); } catch { /* already starting */ }
}

function stopRecognition() {
  state.recMode = null;
  state.listening = false;
  try { state.rec.stop(); } catch {}
  updateVoiceUi();
  renderHud();
}

let audioCtx;
function beep(freq = 880) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx || new Ctx();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const now = audioCtx.currentTime;
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.06, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.3);
  } catch {}
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const plain = String(text)
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/[*_#>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900);
  if (!plain) return;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(plain);
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find((v) => /^en/i.test(v.lang) && /guy|david|mark|male/i.test(v.name)) || voices.find((v) => /^en/i.test(v.lang));
    if (preferred) utter.voice = preferred;
    utter.rate = 1.04;
    utter.pitch = 0.92;
    utter.onstart = () => { state.speaking = true; updateVoiceUi(); renderHud(); };
    utter.onend = () => { state.speaking = false; updateVoiceUi(); renderHud(); };
    utter.onerror = () => { state.speaking = false; updateVoiceUi(); renderHud(); };
    state.speaking = true;
    updateVoiceUi();
    renderHud();
    window.speechSynthesis.speak(utter);
  } catch {}
}

async function setSpeak(on) {
  state.speak = Boolean(on);
  updateVoiceUi();
  if (!state.speak) {
    try { window.speechSynthesis.cancel(); } catch {}
    state.speaking = false;
    renderHud();
  }
  try {
    const res = await api('/api/config', { method: 'POST', body: { voice: { autoSpeak: state.speak } } });
    state.config = res.config;
  } catch {}
}

async function sendMessage(text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  const input = $('#input');
  input.value = '';
  autoGrow();
  $('#composerNote').textContent = '';
  try {
    await api('/api/chat', { method: 'POST', body: { text: clean } });
    renderHud();
  } catch (err) {
    input.value = clean;
    autoGrow();
    toast(err.message, true);
  }
}

function autoGrow() {
  const input = $('#input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 190) + 'px';
}

function setView(view) {
  state.view = view;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  const meta = VIEW_META[view] || VIEW_META.chat;
  $('#viewTitle').textContent = meta[0];
  $('#viewEyebrow').textContent = meta[1];
  if (view === 'missions') {
    api('/api/goals').then((data) => { state.goals = data.goals || state.goals; renderGoals(); }).catch(() => {});
  }
  if (view === 'memory') refreshMemories().catch((err) => toast(err.message, true));
  if (view === 'skills') {
    api('/api/skills').then((data) => { state.skills = data.skills || []; renderSkills(); }).catch(() => {});
  }
  if (view === 'mcp') refreshMcp();
  if (view === 'settings') hydrateSettings();
  if (view === 'chat') setTimeout(() => $('#input').focus(), 30);
}

async function switchSession(id) {
  try {
    const res = await api('/api/session/switch', { method: 'POST', body: { id: Number(id) } });
    state.sessionId = res.id;
    state.streaming = null;
    state.toolChips.clear();
    renderMessages(res.messages || []);
    renderSessions();
  } catch (err) { toast(err.message, true); }
}

async function newThread() {
  try {
    const res = await api('/api/session/new', { method: 'POST', body: { title: 'New thread' } });
    state.sessionId = res.id;
    state.streaming = null;
    state.toolChips.clear();
    renderMessages([]);
    const boot = await api('/api/bootstrap');
    state.sessions = boot.sessions || state.sessions;
    renderSessions();
    toast('New thread started');
  } catch (err) { toast(err.message, true); }
}

async function goalAction(action, id) {
  try {
    if (action === 'delete') {
      if (!window.confirm('Delete mission #' + id + '?')) return;
      await api('/api/goals/' + id, { method: 'DELETE' });
      state.goals = state.goals.filter((g) => g.id !== id);
    } else {
      const status = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'done';
      const res = await api('/api/goals/' + id, { method: 'PATCH', body: { status } });
      const idx = state.goals.findIndex((g) => g.id === id);
      if (idx >= 0) state.goals[idx] = res.goal;
    }
    renderGoals();
    renderHud();
  } catch (err) { toast(err.message, true); }
}

async function addMcpServer() {
  const name = $('#mcpName').value.trim();
  const command = $('#mcpCommand').value.trim();
  const args = $('#mcpArgs').value.trim();
  const url = $('#mcpUrl').value.trim();
  if (!name) return toast('Give the server a name first', true);
  if (!command && !url) return toast('A command or URL is required', true);
  try {
    const res = await api('/api/mcp', { method: 'POST', body: { name, command, args, url } });
    state.mcp = res.servers || state.mcp;
    if (state.config) {
      state.config.mcpServers = state.config.mcpServers || {};
      state.config.mcpServers[name] = url ? { url, enabled: true } : { command, args: args ? args.split(/\s+/) : [], enabled: true };
    }
    $('#mcpName').value = '';
    $('#mcpCommand').value = '';
    $('#mcpArgs').value = '';
    $('#mcpUrl').value = '';
    renderMcp();
    renderHud();
    toast('MCP server connected');
  } catch (err) {
    toast(err.message, true);
    refreshMcp();
  }
}

function micClick() {
  if (!state.voiceSupported) return toast('Speech recognition needs Chrome or Edge', true);
  if (state.wake) { state.wake = false; updateVoiceUi(); }
  const wasActive = state.listening || state.recMode === 'wake';
  if (wasActive) stopRecognition();
  setTimeout(() => startRecognition('command'), wasActive ? 280 : 0);
}

function toggleWake(on) {
  if (on && !state.voiceSupported) {
    $('#wakeToggle').checked = false;
    return toast('Speech recognition needs Chrome or Edge', true);
  }
  state.wake = Boolean(on);
  updateVoiceUi();
  if (on) {
    beep(880);
    startRecognition('wake');
    toast('Wake word armed. Say “' + (state.config?.voice?.wakeWord || 'jarvis') + '” followed by a command.');
  } else if (state.recMode === 'wake') {
    stopRecognition();
  }
}

async function createGoal() {
  const title = $('#goalTitle').value.trim();
  const detail = $('#goalDetail').value.trim();
  if (!title) return toast('Give the mission a title', true);
  try {
    const res = await api('/api/goals', { method: 'POST', body: { title, detail } });
    if (!state.goals.some((g) => g.id === res.goal.id)) state.goals.unshift(res.goal);
    $('#goalTitle').value = '';
    $('#goalDetail').value = '';
    renderGoals();
    renderHud();
    toast('Mission deployed');
  } catch (err) { toast(err.message, true); }
}

async function addMemory() {
  const text = $('#memoryText').value.trim();
  if (!text) return toast('Nothing to remember yet', true);
  try {
    await api('/api/memories', { method: 'POST', body: { text, kind: $('#memoryKind').value, tags: $('#memoryTags').value.trim() } });
    $('#memoryText').value = '';
    $('#memoryTags').value = '';
    await refreshMemories();
    toast('Remembered');
  } catch (err) { toast(err.message, true); }
}

async function deleteMemory(id) {
  try {
    await api('/api/memories/' + id, { method: 'DELETE' });
    state.memories = state.memories.filter((m) => m.id !== id);
    renderMemories();
  } catch (err) { toast(err.message, true); }
}

async function reloadSkills() {
  try {
    const res = await api('/api/skills/reload', { method: 'POST' });
    state.skills = res.skills || [];
    renderSkills();
    renderHud();
    toast('Skills reloaded');
  } catch (err) { toast(err.message, true); }
}

async function toggleSkill(card) {
  if (!card) return;
  card.classList.toggle('open');
  if (!card.classList.contains('open')) return;
  const code = $('.skill-code', card);
  if (code.dataset.loaded) return;
  try {
    const res = await api('/api/skills/' + encodeURIComponent(card.dataset.skill));
    code.textContent = res.skill.body || '(empty skill)';
    code.dataset.loaded = '1';
  } catch (err) {
    code.textContent = err.message;
  }
}

async function handleMcpRow(button) {
  const restart = button.dataset.mcpRestart;
  const remove = button.dataset.mcpRemove;
  try {
    if (restart) {
      const res = await api('/api/mcp/' + encodeURIComponent(restart) + '/restart', { method: 'POST' });
      state.mcp = res.servers || state.mcp;
      toast('Restarted ' + restart);
    } else if (remove) {
      if (!window.confirm('Remove MCP server ' + remove + '?')) return;
      const res = await api('/api/mcp/' + encodeURIComponent(remove), { method: 'DELETE' });
      state.mcp = res.servers || [];
      if (state.config?.mcpServers) delete state.config.mcpServers[remove];
      toast('Removed ' + remove);
    }
    renderMcp();
    renderHud();
  } catch (err) {
    toast(err.message, true);
    refreshMcp();
  }
}

function bindEvents() {
  $$('.nav-btn').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#sessionSelect').addEventListener('change', (e) => switchSession(e.target.value));
  $('#newThread').addEventListener('click', newThread);
  $('#sendBtn').addEventListener('click', () => sendMessage($('#input').value));
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage($('#input').value);
    }
  });
  $('#input').addEventListener('input', autoGrow);
  $('#stopBtn').addEventListener('click', async () => {
    try { await api('/api/stop', { method: 'POST' }); toast('Stopped'); } catch (err) { toast(err.message, true); }
  });
  $('#micBtn').addEventListener('click', micClick);
  $('#railVoice').addEventListener('click', micClick);
  $('#wakeToggle').addEventListener('change', (e) => toggleWake(e.target.checked));
  $('#speakToggle').addEventListener('change', (e) => setSpeak(e.target.checked));
  $('#messages').addEventListener('click', (e) => {
    const s = e.target.closest('.suggestion');
    if (s) sendMessage(s.dataset.prompt);
  });
  $('#clearActivity').addEventListener('click', () => { state.activities = []; renderActivity(); });
  $('#goalCreate').addEventListener('click', createGoal);
  $('#refreshMissions').addEventListener('click', () => {
    api('/api/goals').then((data) => { state.goals = data.goals || []; renderGoals(); }).catch((err) => toast(err.message, true));
  });
  $('#goalList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) goalAction(b.dataset.act, Number(b.dataset.id));
  });
  $('#reminderList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-reminder-cancel]');
    if (!b) return;
    const id = Number(b.dataset.reminderCancel);
    try {
      await api('/api/reminders/' + id, { method: 'DELETE' });
      state.agent.reminders = (state.agent.reminders || []).filter((r) => r.id !== id);
      renderReminders();
      toast('Reminder cancelled');
    } catch (err) { toast(err.message, true); }
  });
  $('#memoryAdd').addEventListener('click', addMemory);
  $('#memorySearch').addEventListener('input', renderMemories);
  $('#refreshMemory').addEventListener('click', () => refreshMemories().catch((err) => toast(err.message, true)));
  $('#memoryList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-memory]');
    if (b) deleteMemory(Number(b.dataset.memory));
  });
  $('#reloadSkills').addEventListener('click', reloadSkills);
  $('#skillList').addEventListener('click', (e) => toggleSkill(e.target.closest('.skill-card')));
  $('#mcpAdd').addEventListener('click', addMcpServer);
  $('#refreshMcp').addEventListener('click', refreshMcp);
  $('#mcpList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mcp-restart], [data-mcp-remove]');
    if (b) handleMcpRow(b);
  });
  $('#saveConfig').addEventListener('click', saveSettings);
  $('#saveModelKey').addEventListener('click', saveModelKey);
  $('#saveTelegram').addEventListener('click', saveTelegram);
  $('#telegramTest').addEventListener('click', async () => {
    try { await api('/api/telegram/test', { method: 'POST' }); toast('Test message sent'); }
    catch (err) { toast(err.message, true); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      setView('chat');
      $('#input').focus();
    }
  });
}

async function init() {
  bindEvents();
  initVoice();
  try {
    await loadBootstrap();
  } catch (err) {
    toast('Cannot reach Jarvis: ' + err.message, true);
    $('#messages').innerHTML = '<div class="empty-chat"><div class="glyph">!</div><h2>Backend unreachable</h2><p>' + escapeHtml(err.message) + '</p><p>Start the server with <code>node server/index.mjs</code>.</p></div>';
  }
  connectEvents();
  setView('chat');
  autoGrow();
  setInterval(() => {
    const g = state.goals.find((x) => x.status === 'active');
    const next = $('#missionNext');
    if (g && next) next.textContent = whenIn(g.next_wake);
  }, 15000);
}

init();
