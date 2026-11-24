import { nextUtcMidnight } from './time.js';

// 限额数字全部来自当次 JSON，函数里没有 1000、200、40000000 这类常量。
function readCount(obj, key) {
  if (!obj || typeof obj !== 'object' || !Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  const v = obj[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
  return null;
}

function parseBig(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return null;
}

function unknown(detail) {
  return { action: 'stop', reason: 'unknown-structure', detail };
}

function wait(reason, extra = {}) {
  return { action: 'wait', reason, ...extra };
}

// 实况字段：dailyNewSponsorships.limit、dailyStakeBudget.usedFlop/limitFlop。
// 若以后改名成 used/limit 或 used/max，只接受这两种已经见过的形状，对不上就停止。
export function parseLimits(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unknown('根节点不是对象');
  if (typeof raw.network !== 'string' || !raw.network) return unknown('缺少 network');
  const m = raw.sponsor?.miner;
  if (!m || typeof m !== 'object') return unknown('缺少 sponsor.miner');
  if (typeof m.status !== 'string' || !m.status) return unknown('缺少 sponsor.miner.status');
  const capUsed = readCount(m.capacity, 'used');
  const capMax = readCount(m.capacity, 'max');
  if (capUsed == null || capMax == null) return unknown('capacity.used/max 无法解析');
  const daily = m.dailyNewSponsorships;
  if (!daily || typeof daily !== 'object') return unknown('缺少 dailyNewSponsorships');
  const dailyUsed = readCount(daily, 'used');
  const dailyCap = Object.prototype.hasOwnProperty.call(daily, 'limit')
    ? readCount(daily, 'limit')
    : readCount(daily, 'max');
  if (dailyUsed == null || dailyCap == null) return unknown('dailyNewSponsorships 的 used 与 limit/max 无法解析');
  const budget = readStake(m.dailyStakeBudget);
  if (!budget) return unknown('dailyStakeBudget 不是 usedFlop/limitFlop 或 used/limit');
  const auto = m.automatic;
  if (!auto || typeof auto !== 'object' || typeof auto.open !== 'boolean') return unknown('缺少 automatic.open');
  const uncal = readCount(auto, 'uncalibrated');
  const uncalMax = readCount(auto, 'max');
  const grace = readCount(auto, 'graceHours');
  if (uncal == null || uncalMax == null || grace == null) return unknown('automatic.uncalibrated/max/graceHours 无法解析');
  return {
    action: 'parsed',
    network: raw.network,
    stale: raw.stale === true,
    status: m.status,
    capacity: { used: capUsed, max: capMax },
    dailyNew: { used: dailyUsed, limit: dailyCap },
    stake: budget,
    automatic: { open: auto.open, uncalibrated: uncal, max: uncalMax, graceHours: grace },
  };
}

function readStake(b) {
  if (!b || typeof b !== 'object') return null;
  if ('usedFlop' in b || 'limitFlop' in b) {
    const used = parseBig(b.usedFlop);
    const limit = parseBig(b.limitFlop);
    if (used == null || limit == null) return null;
    return { used, limit, fields: 'usedFlop/limitFlop' };
  }
  if ('used' in b || 'limit' in b) {
    const used = parseBig(b.used);
    const limit = parseBig(b.limit);
    if (used == null || limit == null) return null;
    return { used, limit, fields: 'used/limit' };
  }
  return null;
}

export function decideSeat(raw, cfg, nowMs) {
  const parsed = parseLimits(raw);
  if (parsed.action === 'stop') return parsed;
  if (parsed.stale) return wait('stale');
  if (parsed.network !== cfg.network) return wait('network', { have: parsed.network, want: cfg.network });
  if (parsed.status !== 'open') return wait('status', { status: parsed.status });
  if (parsed.capacity.used >= parsed.capacity.max) return wait('capacity');
  if (parsed.dailyNew.used >= parsed.dailyNew.limit) {
    return wait('daily-new', { until: nextUtcMidnight(nowMs) });
  }
  if (parsed.stake.used >= parsed.stake.limit) return wait('daily-stake');
  if (!parsed.automatic.open && cfg.sponsorMode !== 'review') return wait('automatic-closed');
  if (parsed.automatic.uncalibrated >= parsed.automatic.max && cfg.sponsorMode !== 'review') {
    return wait('uncalibrated');
  }
  return {
    action: 'pass',
    reason: 'seat-open',
    graceHours: parsed.automatic.graceHours,
    snapshot: {
      network: parsed.network,
      status: parsed.status,
      capacity: parsed.capacity,
      dailyNew: parsed.dailyNew,
      stake: { used: parsed.stake.used.toString(), limit: parsed.stake.limit.toString() },
      automatic: parsed.automatic,
    },
  };
}
