// In-code approval gate. Risky tool calls block here until the *user* approves
// them from the UI or the paired Telegram chat. The model cannot satisfy this
// by passing confirm=true: that argument is ignored.
const pending = new Map();
let seq = 0;

export function listApprovals() {
  return [...pending.values()].map(({ id, tool, summary, createdAt, expiresAt }) => ({ id, tool, summary, createdAt, expiresAt }));
}

export function resolveApproval(id, approved, by = 'user') {
  const entry = pending.get(Number(id));
  if (!entry) return false;
  entry.finish(Boolean(approved), approved ? 'approved by ' + by : 'denied by ' + by);
  return true;
}

export function denyAll(reason = 'cancelled') {
  for (const entry of [...pending.values()]) entry.finish(false, reason);
}

// ctx: { cfg, signal, emit, telegram }. Resolves on approval, throws on denial / timeout / abort.
export function requireApproval(ctx, tool, summary) {
  if (ctx.cfg?.safety?.requireApproval === false) return Promise.resolve();
  const id = ++seq;
  const timeoutMs = Math.max(30, Number(ctx.cfg?.agent?.approvalTimeoutSec) || 300) * 1000;
  const text = String(summary).slice(0, 1500);
  return new Promise((resolve, reject) => {
    const entry = { id, tool, summary: text, createdAt: Date.now(), expiresAt: Date.now() + timeoutMs };
    const onAbort = () => entry.finish(false, 'the turn was stopped');
    entry.finish = (approved, reason) => {
      if (!pending.has(id)) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      ctx.emit?.('approval', { action: approved ? 'approved' : 'denied', id, reason });
      if (approved) resolve();
      else reject(new Error('Not approved (' + reason + '). Do not retry this action unless the user asks again.'));
    };
    entry.timer = setTimeout(() => entry.finish(false, 'timed out waiting for the user'), timeoutMs);
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal?.aborted) return onAbort();
    pending.set(id, entry);
    ctx.emit?.('approval', { action: 'requested', id, tool, summary: text, expiresAt: entry.expiresAt });
    if (ctx.telegram?.ready?.()) {
      ctx.telegram.send('🔐 Approval needed #' + id + ' — ' + tool + '\n\n' + text + '\n\nReply /approve ' + id + ' or /deny ' + id).catch(() => {});
    }
  });
}
