import fs from 'node:fs';
import path from 'node:path';
import { modelKey, isLocalBase } from './config.mjs';
import { parseCompletion } from './llm.mjs';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

export async function seeImage(file, prompt, cfg, signal) {
  const ext = path.extname(file).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error('Unsupported image type ' + (ext || '(none)') + '. Use PNG, JPEG, WebP or GIF.');
  const stat = fs.statSync(file);
  if (stat.size > 8 * 1024 * 1024) throw new Error('Image is larger than 8 MB');
  const key = modelKey();
  if (!key && !isLocalBase(cfg.model.baseUrl)) throw new Error('No model API key configured for image analysis');
  const data = fs.readFileSync(file).toString('base64');
  const text = String(prompt || 'Describe this image precisely. Extract all visible text, UI state, and anything relevant to the task.').slice(0, 2000);
  const body = {
    model: cfg.model.model,
    temperature: 0.2,
    max_tokens: 1000,
    messages: [{ role: 'user', content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + data } }
    ] }]
  };
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;
  const res = await fetch(String(cfg.model.baseUrl || '').replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST', headers, body: JSON.stringify(body), signal: signal || AbortSignal.timeout(90000)
  });
  const raw = await res.text();
  if (!res.ok) {
    let msg = raw.slice(0, 500);
    try { msg = JSON.parse(raw).error?.message || msg; } catch {}
    throw new Error('Vision request failed (' + res.status + '): ' + msg);
  }
  const json = parseCompletion(raw);
  const out = json.choices?.[0]?.message?.content;
  if (Array.isArray(out)) return out.map((x) => x.text || '').join('\n');
  if (typeof out === 'string') return out;
  throw new Error('Model returned no image description');
}
