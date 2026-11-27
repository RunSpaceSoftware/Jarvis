import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const SECRETS_DIR = path.join(ROOT, 'secrets');
export const CONFIG_PATH = path.join(ROOT, 'config', 'config.json');

const DEFAULTS = {
  name: 'Jarvis',
  user: 'Sir',
  model: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    temperature: 0.6,
    maxTokens: 4096,
    contextMessages: 40,
    compactAfter: 60
  },
  server: { port: 8787, host: '127.0.0.1' },
  agent: {
    autopilot: true,
    autonomyIntervalSec: 180,
    maxStepsPerTurn: 30,
    maxGoalRuns: 200,
    shellTimeoutSec: 120
  },
  telegram: { enabled: true, chatId: '', updateMinutes: 3, voiceReplies: false },
  voice: { wakeWord: 'jarvis', autoSpeak: true },
  mcpServers: {},
  safety: {
    workspace: 'workspace',
    allowShell: true,
    allowedCommands: [],
    allowOutsideWorkspace: false,
    blockSecrets: true
  }
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function merge(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (isObj(v) && isObj(base[k])) merge(base[k], v);
    else if (v !== undefined) base[k] = v;
  }
  return base;
}

export function workspaceDir(cfg) {
  const raw = String(cfg?.safety?.workspace || 'workspace').trim();
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(ROOT, raw);
}

export function ensureWorkspace(cfg) {
  const dir = workspaceDir(cfg);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.statSync(dir).isDirectory()) throw new Error('Workspace is not a folder: ' + dir);
  const realWs = fs.realpathSync(dir);
  const realSecrets = fs.existsSync(SECRETS_DIR) ? fs.realpathSync(SECRETS_DIR) : SECRETS_DIR;
  const rel = path.relative(realSecrets, realWs);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    throw new Error('Workspace cannot be inside the secrets folder: ' + dir);
  }
  return dir;
}

export function ensureDirs() {
  for (const d of [DATA_DIR, SECRETS_DIR, path.join(ROOT, 'config'), path.join(ROOT, 'skills')]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function loadConfig() {
  ensureDirs();
  let extra = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try { extra = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
    catch (err) { console.error('[config] ignoring invalid config.json:', err.message); }
  }
  const cfg = merge(structuredClone(DEFAULTS), extra);
  cfg.safety.workspace = ensureWorkspace(cfg);
  if (process.env.JARVIS_PORT) cfg.server.port = Number(process.env.JARVIS_PORT);
  if (process.env.JARVIS_MODEL) cfg.model.model = process.env.JARVIS_MODEL;
  if (process.env.JARVIS_BASE_URL) cfg.model.baseUrl = process.env.JARVIS_BASE_URL;
  return cfg;
}

export function saveConfig(cfg) {
  ensureDirs();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

function readSecretFile(names) {
  for (const name of names) {
    const file = path.join(SECRETS_DIR, name);
    if (fs.existsSync(file)) {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value && !value.startsWith('PASTE_')) return value;
    }
  }
  return '';
}

export function modelKey() {
  return readSecretFile(['model_key.txt', 'api_key.txt']) || process.env.JARVIS_MODEL_KEY || process.env.OPENAI_API_KEY || '';
}

export function telegramToken() {
  return readSecretFile(['telegram_token.txt', 'telegram.txt']) || process.env.JARVIS_TELEGRAM_TOKEN || '';
}

export function discordToken() {
  return readSecretFile(['discord_token.txt']) || process.env.JARVIS_DISCORD_TOKEN || '';
}

export function isLocalBase(baseUrl) {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(String(baseUrl || ''));
}

export function publicConfig(cfg, opts = {}) {
  const copy = structuredClone(cfg);
  copy.secrets = {
    modelKey: Boolean(modelKey()),
    telegramToken: Boolean(telegramToken()),
    discordToken: Boolean(discordToken())
  };
  copy.model.configured = Boolean(modelKey()) || isLocalBase(cfg.model.baseUrl);
  copy.paths = {
    workspace: workspaceDir(cfg),
    keyFile: path.join(SECRETS_DIR, 'model_key.txt'),
    configFile: CONFIG_PATH
  };
  return copy;
}
