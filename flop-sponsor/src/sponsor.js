import { createSingleFlight } from './lock.js';

// 官方 sponsor.sh 在容器里打印：地址、HTTP 状态、JSON。只认这一行，认不出就交给上层停止。
export function parseSponsorStdout(text) {
  for (const line of String(text).split(/\n/)) {
    const m = line.match(/^([1-9A-HJ-NP-Za-km-z]{46,50})\s+(200|201|403|409|422|429|503)\b/);
    if (!m) continue;
    const jsonAt = line.indexOf('{');
    let body = {};
    if (jsonAt >= 0) {
      try { body = JSON.parse(line.slice(jsonAt)); } catch { body = {}; }
    }
    return { address: m[1], status: Number(m[2]), body };
  }
  return null;
}

const flight = createSingleFlight();

export function interpretSponsor(status, body) {
  const reason = body && typeof body === 'object' ? body.reason : undefined;
  const action = body && typeof body === 'object' ? body.action : undefined;
  const retryAfter = body && typeof body === 'object' ? body.retryAfterSeconds : undefined;
  const waitMs = Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : null;
  if (reason === 'account_busy') {
    return { action: 'retry', reason: 'account_busy', waitMs: waitMs ?? 60_000, sameAddress: true };
  }
  if (status === 200 || status === 201) return { action: 'ok', reason: 'sponsored' };
  if (status === 409) return { action: 'ok', reason: 'already-sponsored' };
  if (status === 403) return { action: 'stop', reason: action || reason || 'forbidden' };
  if (status === 429) {
    if (action === 'report_to_operator') return { action: 'stop', reason: reason || 'report_to_operator' };
    if (waitMs == null) return { action: 'stop', reason: '429-without-retryAfterSeconds' };
    return { action: 'retry', reason: reason || '429', waitMs, sameAddress: true };
  }
  if (status === 503) {
    return { action: 'retry', reason: reason || '503', waitMs: waitMs ?? null, sameAddress: true };
  }
  return { action: 'stop', reason: reason || `http-${status}` };
}

export function createRateLimiter({ limit = 6, windowMs = 60_000, now = Date.now, sleep }) {
  const stamps = [];
  return async function take() {
    for (;;) {
      const t = now();
      while (stamps.length && t - stamps[0] >= windowMs) stamps.shift();
      if (stamps.length < limit) {
        stamps.push(t);
        return;
      }
      const wait = windowMs - (t - stamps[0]);
      await sleep(wait);
    }
  };
}

// 全局单飞：同一时间只有一个 POST。account_busy 在锁内只再试一次，仍用同一地址和同一正文。
export async function submitSponsor({ post, body, limiter, sleep }) {
  return flight(async () => {
    await limiter();
    let res = await post(body);
    let decision = interpretSponsor(res.status, res.data);
    if (decision.reason === 'account_busy') {
      await sleep(decision.waitMs);
      await limiter();
      res = await post(body);
      decision = interpretSponsor(res.status, res.data);
      if (decision.action === 'retry') {
        decision = { action: 'stop', reason: 'account_busy-again', sameAddress: true };
      }
    }
    return { status: res.status, data: res.data, decision };
  });
}
