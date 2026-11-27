import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureWorkspace } from './config.mjs';

function run(args, cfg, timeout = 20000) {
  const ws = ensureWorkspace(cfg);
  return new Promise((resolve, reject) => {
    const safe = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.pager=cat', ...args];
    const child = spawn('git', safe, { cwd: ws, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('git timed out')); }, timeout);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = (stdout + (stderr ? '\n[stderr]\n' + stderr : '')).trim();
      resolve('git ' + args.join(' ') + ' → ' + code + '\n' + (out.length > 16000 ? out.slice(0, 16000) + '\n...[truncated]' : out));
    });
  });
}

function relPath(p, cfg) {
  if (!p) return '';
  const ws = ensureWorkspace(cfg);
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(ws, p);
  const rel = path.relative(ws, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path is outside the workspace');
  return rel;
}

export async function gitTool(args = {}, cfg) {
  const action = String(args.action || 'status');
  const rel = relPath(args.path, cfg);
  if (action === 'status') return run(['status', '--short', '--branch'], cfg);
  if (action === 'diff') return run(['diff', '--no-textconv', ...(args.staged ? ['--cached'] : []), ...(rel ? ['--', rel] : [])], cfg);
  if (action === 'log') return run(['log', '--oneline', '-n', String(Math.max(1, Math.min(50, Number(args.max) || 15)))], cfg);
  if (action === 'show') {
    const ref = String(args.ref || 'HEAD');
    if (ref.startsWith('-') || !/^[A-Za-z0-9._/@{}^~:-]+$/.test(ref)) throw new Error('Invalid ref');
    return run(['show', '--no-textconv', '--stat', ref], cfg);
  }
  throw new Error('Unknown git action: ' + action);
}
