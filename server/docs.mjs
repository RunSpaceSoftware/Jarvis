import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docs.py');
const TEXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.xml', '.html', '.htm', '.yaml', '.yml']);
const DOC = new Set(['.docx', '.pptx', '.xlsx', '.xlsm', '.pdf']);

export function readDocument(file) {
  const ext = path.extname(file).toLowerCase();
  if (TEXT.has(ext)) {
    const text = fs.readFileSync(file, 'utf8');
    return text.length > 20000 ? text.slice(0, 20000) + '\n...[truncated]' : text;
  }
  if (!DOC.has(ext)) throw new Error('Unsupported document type ' + (ext || '(none)') + '. Supported: ' + [...TEXT, ...DOC].join(' '));
  return new Promise((resolve, reject) => {
    const child = spawn('python', [SCRIPT, file], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error('Document extraction timed out'));
    }, 30000);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error((stderr || stdout || 'Document extraction failed').trim()));
    });
  });
}
