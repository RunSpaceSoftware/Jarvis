import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

export const SKILLS_DIR = path.join(ROOT, 'skills');
let cache = [];

function parseFrontmatter(raw, fallbackName) {
  const meta = { name: fallbackName, description: '' };
  let body = raw;
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end !== -1) {
      const head = raw.slice(3, end).split('\n');
      for (const line of head) {
        const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
        if (m) meta[m[1].toLowerCase()] = m[2].trim().replace(/^['\"]|['\"]$/g, '');
      }
      body = raw.slice(raw.indexOf('\n', end + 1) + 1).trim();
    }
  }
  return { ...meta, body };
}

export function loadSkills() {
  cache = [];
  if (!fs.existsSync(SKILLS_DIR)) return cache;
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'), entry.name);
      cache.push({ name: parsed.name || entry.name, description: parsed.description || '', body: parsed.body, file });
    } catch (err) {
      console.error('[skills] failed to load', file, err.message);
    }
  }
  return cache;
}

export function listSkills() {
  if (!cache.length) loadSkills();
  return cache.map((s) => ({ name: s.name, description: s.description, file: s.file, body: s.body }));
}

export function getSkill(name) {
  if (!cache.length) loadSkills();
  const key = String(name || '').toLowerCase();
  return cache.find((s) => s.name.toLowerCase() === key) || null;
}

export function skillsIndex() {
  const skills = listSkills();
  if (!skills.length) return '(no skills installed)';
  return skills.map((s) => '- ' + s.name + ': ' + s.description).join('\n');
}
