// /limits 大约一分钟刷新一次。默认把轮询夹在 30–60 秒，避免把水龙头打成高频。
export const MIN_POLL_MS = 30_000;
export const MAX_POLL_DEFAULT_MS = 60_000;
export const SEAT_TTL_MS = 10 * 60 * 1000;
export const CREATE_COOLDOWN_MS = 5_000;
export const RECONCILE_WINDOW_SEC = 120;

export function nextUtcMidnight(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

export function pollDelayMs(rng = Math.random, cfg = {}) {
  const floor = cfg.allowFastPoll ? 0 : MIN_POLL_MS;
  const min = Math.max(floor, Number(cfg.pollMinMs ?? MIN_POLL_MS));
  const max = Math.max(min, Number(cfg.pollMaxMs ?? MAX_POLL_DEFAULT_MS));
  const n = Number(rng());
  const unit = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
  return Math.floor(min + unit * (max - min));
}

export function utcDay(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function readGraceHours(raw, fallback = 4) {
  const value = raw?.sponsor?.miner?.automatic?.graceHours;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return fallback;
}

// 赞助成功后的租机窗口。剩余时间不够开机加校准则需要人接手。
export function graceWindow({ sponsoredAt, graceHours, bootEstimateMs, calibrateEstimateMs, now }) {
  if (typeof sponsoredAt !== 'number') return { ok: false, reason: 'missing-sponsoredAt' };
  const need = Number(bootEstimateMs) + Number(calibrateEstimateMs);
  const deadline = sponsoredAt + graceHours * 3600 * 1000;
  const remain = deadline - now;
  if (remain < need) return { ok: false, reason: 'grace-too-short', remain, need, deadline };
  return { ok: true, remain, need, deadline };
}
