import { modelKey, isLocalBase } from './config.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function apiBase(cfg) {
  return String(cfg.model.baseUrl || '').replace(/\/+$/, '');
}

function headers(cfg) {
  const key = modelKey();
  const h = { 'Content-Type': 'application/json' };
  if (key) h.Authorization = 'Bearer ' + key;
  return h;
}

async function readError(res) {
  let text = '';
  try { text = await res.text(); } catch {}
  let message = text.slice(0, 600);
  try { const j = JSON.parse(text); message = j.error?.message || j.message || message; } catch {}
  if (res.status === 401 || res.status === 403) message = 'Model API rejected the key (' + res.status + '): ' + message;
  return new Error(message || ('Model request failed with HTTP ' + res.status));
}

function buildBody(cfg, { messages, tools, stream, temperature }) {
  const body = {
    model: cfg.model.model,
    messages,
    stream: Boolean(stream),
    temperature: temperature ?? cfg.model.temperature
  };
  if (cfg.model.maxTokens) body.max_tokens = cfg.model.maxTokens;
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  return body;
}

export async function chat(cfg, { messages, tools = [], onDelta, signal, temperature }) {
  const key = modelKey();
  if (!key && !isLocalBase(cfg.model.baseUrl)) {
    throw new Error('No model API key. Put your key in secrets/model_key.txt (or set OPENAI_API_KEY) and reload.');
  }
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const res = await fetch(apiBase(cfg) + '/chat/completions', {
        method: 'POST', headers: headers(cfg), signal,
        body: JSON.stringify(buildBody(cfg, { messages, tools, stream: true, temperature }))
      });
      if (!res.ok) {
        const err = await readError(res);
        if (res.status === 429 || res.status >= 500) { lastErr = err; await sleep(1500 * (attempt + 1)); continue; }
        throw err;
      }
      return await parseStream(res, onDelta);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastErr = err;
      if (attempt < 2 && /fetch failed|ECONN|timeout|network/i.test(err.message || '')) { await sleep(1200 * (attempt + 1)); continue; }
      throw err;
    }
  }
  throw lastErr;
}

async function parseStream(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finishReason = null;
  let usage = null;
  const calls = new Map();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
      if (json.usage) usage = json.usage;
      const choice = json.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        onDelta?.(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? calls.size;
          const cur = calls.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.function.name += tc.function.name;
          if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
          calls.set(idx, cur);
        }
      }
    }
  }
  return { content, toolCalls: [...calls.values()].filter((c) => c.function.name), usage, finishReason };
}

export function parseCompletion(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Model returned an empty response');
  try { return JSON.parse(text); } catch {}
  const marker = text.indexOf('data:');
  if (marker > 0) {
    try { return JSON.parse(text.slice(0, marker).trim()); } catch {}
  }
  let content = '';
  let saw = false;
  let usage = null;
  let finishReason = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let json;
    try { json = JSON.parse(payload); } catch { continue; }
    const choice = json.choices?.[0];
    if (!choice) continue;
    saw = true;
    if (json.usage) usage = json.usage;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (typeof choice.message?.content === 'string') content += choice.message.content;
    if (typeof choice.delta?.content === 'string') content += choice.delta.content;
  }
  if (saw) return { choices: [{ message: { content }, finish_reason: finishReason }], usage };
  throw new Error('Model returned a non-JSON response (' + text.length + ' bytes)');
}

export async function complete(cfg, { messages, signal, temperature = 0.2, maxTokens } = {}) {
  const key = modelKey();
  if (!key && !isLocalBase(cfg.model.baseUrl)) throw new Error('No model API key configured');
  const body = buildBody(cfg, { messages, tools: [], stream: false, temperature });
  if (maxTokens) body.max_tokens = maxTokens;
  const res = await fetch(apiBase(cfg) + '/chat/completions', {
    method: 'POST', headers: headers(cfg), signal, body: JSON.stringify(body)
  });
  if (!res.ok) throw await readError(res);
  const json = parseCompletion(await res.text());
  return json.choices?.[0]?.message?.content || '';
}

export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}
