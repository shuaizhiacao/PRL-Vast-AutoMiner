// 报价、出价上限、扫描热窗口、利润底线。纯函数，方便离线测试。
//
// vast.ai 字段和单位（对照 docs.vast.ai「search offers / creating instances」
// 和官方 vast-cli search__offers，本文件按这些单位计算，不另发明字段）：
//   type:            "on-demand" | "bid" | "reserved"
//                    CLI 发 "on-demand"；OpenAPI 里也出现过不带连字符的 "ondemand"。
//                    本程序沿用已经在用的 CLI 字符串 "on-demand" 和 "bid"。
//   min_bid:         可中断实例的最低算力出价，美元/小时
//   PUT /asks/{id}/ 的 price: 可中断出价，美元/小时。省略或 null = 按需，不会变成出价单
//   dph_base:        按需算力价，美元/小时
//   dph_total:       按需合计时租（通常含本次 allocated_storage 的存储），美元/小时
//   search.gpuCostPerHour / search.diskHour: 搜索结果里按本次磁盘算出的美元/小时
//   storage_cost:    美元/GB/月
//   inet_up_cost / inet_down_cost: 美元/GB（按流量，不在 dph_total 里）
// 存储从「美元/GB/月」折到小时时用 30*24。这是月费率的常用折算，不是 vast 单独公布的小时单价。
// 带宽只在费率是有限数时，按配置的 bandwidthGbPerHour 计入。那个用量是可配置上限，不是实测流量。

export const HOURS_PER_MONTH = 30 * 24;

export function finiteNum(v) {
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : (v == null ? NaN : Number(v));
  return Number.isFinite(n) ? n : null;
}

export function rentModeOf(cfg) {
  return cfg?.rentMode === 'ondemand' ? 'ondemand' : 'interruptible';
}

export function vastSearchType(mode) {
  return mode === 'ondemand' ? 'on-demand' : 'bid';
}

export function bandwidthHourly(raw, gbPerHour) {
  const allowance = finiteNum(gbPerHour);
  if (allowance == null || allowance < 0) return { ok: false, why: '带宽用量设置无效' };
  const upMissing = raw?.inet_up_cost == null || raw?.inet_up_cost === '';
  const downMissing = raw?.inet_down_cost == null || raw?.inet_down_cost === '';
  // 两个字段都缺：未知，不是 0。只有明确写出 0 才是免费流量。缺一边也算不齐。
  if (upMissing || downMissing) return { ok: true, known: false, hr: null, why: '带宽单价未知' };
  const up = finiteNum(raw.inet_up_cost);
  const down = finiteNum(raw.inet_down_cost);
  if (up == null || down == null || up < 0 || down < 0) return { ok: false, why: '带宽单价无效' };
  return { ok: true, known: true, hr: (up + down) * allowance };
}

export function storageHourly(raw, diskGb) {
  const disk = finiteNum(diskGb);
  if (disk == null || disk <= 0) return { ok: false, why: '磁盘大小无效' };
  const diskHour = finiteNum(raw?.search?.diskHour);
  if (diskHour != null) {
    if (diskHour < 0) return { ok: false, why: '存储时租无效' };
    return { ok: true, known: true, hr: diskHour, source: 'search.diskHour' };
  }
  const rate = finiteNum(raw?.storage_cost);
  if (rate == null) return { ok: true, known: false, hr: null, source: 'missing' };
  if (rate < 0) return { ok: false, why: '存储单价无效' };
  return { ok: true, known: true, hr: rate * disk / HOURS_PER_MONTH, source: 'storage_cost' };
}

// 给一条报价算「我们真正会付的时租」。可中断用 min_bid 上浮后、再被经济上限截断的出价，
// 而不是按需 dph，也不是 FLOPS。缺数字或数字无效就失败，调用方不得下单。
export function quoteOffer(raw, cfg, { revenuePerHsHour, hashrateHs, mode } = {}) {
  const rentMode = mode || rentModeOf(cfg);
  const revRate = finiteNum(revenuePerHsHour);
  if (!(revRate > 0)) return { ok: false, why: '收益价缺失或不是正数' };
  const hs = finiteNum(hashrateHs);
  if (!(hs > 0)) return { ok: false, why: '算力缺失或无效' };
  const revenueHr = hs * revRate;
  const bw = bandwidthHourly(raw, cfg?.bandwidthGbPerHour ?? 0);
  if (!bw.ok) return { ok: false, why: bw.why };
  if (!bw.known) return { ok: false, why: '带宽单价未知，成本不齐，不能下单' };
  const st = storageHourly(raw, cfg?.disk);
  if (!st.ok) return { ok: false, why: st.why };
  const target = finiteNum(cfg?.targetProfitPct);
  const uplift = finiteNum(cfg?.bidUpliftPct);
  if (target == null || uplift == null) return { ok: false, why: '目标收益率或出价上浮无效' };

  if (rentMode === 'interruptible') {
    const minBid = finiteNum(raw?.min_bid);
    if (!(minBid > 0)) return { ok: false, why: '缺少有效的 min_bid（美元/小时）' };
    if (!st.known) return { ok: false, why: '缺少存储费用，无法计算可中断实例的总成本' };
    const planned = planBid({
      minBid, storageHr: st.hr, bandwidthHr: bw.hr, revenueHr,
      targetProfitPct: target, upliftPct: uplift, budgetHr: 1e12,
    });
    const bare = minBid + st.hr + bw.hr;
    if (!planned.ok) {
      const roi = bare > 0 ? (revenueHr - bare) / bare * 100 : null;
      return {
        ok: true, rentable: false, why: planned.why, rentMode, legacyTotal: false,
        revenueHr, computeHr: minBid, storageHr: st.hr, bandwidthHr: bw.hr, bandwidthKnown: bw.known,
        dph: bare, minBid, bid: null, maxBid: planned.maxBid ?? null,
        roi, th: hs / 1e12, thPerDollar: bare > 0 ? (hs / 1e12) / bare : 0,
        thPer01: bare > 0 ? (hs / 1e12) / (bare / 0.1) : 0,
      };
    }
    return {
      ok: true, rentable: planned.roi + 1e-6 >= target, why: '', rentMode, legacyTotal: false,
      revenueHr, computeHr: planned.bid, storageHr: st.hr, bandwidthHr: bw.hr, bandwidthKnown: bw.known,
      dph: planned.total, minBid, bid: planned.bid, maxBid: planned.maxBid,
      roi: planned.roi, th: hs / 1e12, thPerDollar: (hs / 1e12) / planned.total,
      thPer01: (hs / 1e12) / (planned.total / 0.1),
    };
  }

  const gpu = finiteNum(raw?.search?.gpuCostPerHour);
  const base = finiteNum(raw?.dph_base);
  let compute = gpu != null && gpu > 0 ? gpu : (base != null && base > 0 ? base : null);
  if (compute != null && !st.known) return { ok: false, why: '按需报价有算力价但没有存储费用' };
  if (compute == null) {
    const total = finiteNum(raw?.dph_total);
    if (!(total > 0)) return { ok: false, why: '缺少有效的按需时租 dph_total' };
    const roi = (revenueHr - total) / total * 100;
    return {
      ok: true, rentable: roi + 1e-6 >= target, why: '', rentMode, legacyTotal: true,
      revenueHr, computeHr: null, storageHr: 0, bandwidthHr: 0, bandwidthKnown: false,
      dph: total, minBid: finiteNum(raw?.min_bid), bid: null, maxBid: null,
      roi, th: hs / 1e12, thPerDollar: (hs / 1e12) / total,
      thPer01: (hs / 1e12) / (total / 0.1),
    };
  }
  const dph = compute + st.hr + bw.hr;
  if (!(dph > 0)) return { ok: false, why: '按需总成本无效' };
  const roi = (revenueHr - dph) / dph * 100;
  return {
    ok: true, rentable: roi + 1e-6 >= target, why: '', rentMode, legacyTotal: false,
    revenueHr, computeHr: compute, storageHr: st.hr, bandwidthHr: bw.hr, bandwidthKnown: bw.known,
    dph, minBid: finiteNum(raw?.min_bid), bid: null, maxBid: null,
    roi, th: hs / 1e12, thPerDollar: (hs / 1e12) / dph,
    thPer01: (hs / 1e12) / (dph / 0.1),
  };
}

// bid = min(min_bid * (1+上浮), 经济上限, 预算)。上浮默认落在 2–5%。
// 经济上限：总时租 <= 收益 / (1 + 目标收益率)。最低出价本身超标就拒绝，不允许为了抢机器出更高的价。
export function planBid({ minBid, storageHr, bandwidthHr, revenueHr, targetProfitPct, upliftPct, budgetHr }) {
  const floor = finiteNum(minBid);
  const storage = finiteNum(storageHr);
  const bw = finiteNum(bandwidthHr);
  const rev = finiteNum(revenueHr);
  const target = finiteNum(targetProfitPct);
  const uplift = finiteNum(upliftPct);
  const budget = finiteNum(budgetHr);
  if (!(floor > 0)) return { ok: false, why: '最低出价无效' };
  if (storage == null || storage < 0 || bw == null || bw < 0) return { ok: false, why: '非算力费用无效' };
  if (!(rev > 0)) return { ok: false, why: '收益价无效' };
  if (target == null || !(budget > 0)) return { ok: false, why: '目标收益率或预算无效' };
  if (uplift == null || uplift < 0 || uplift > 8) return { ok: false, why: '出价上浮超出 0–8%' };
  const nonCompute = storage + bw;
  const maxTotal = rev / (1 + target / 100);
  const maxBid = maxTotal - nonCompute;
  const cap = Math.min(maxBid, budget - nonCompute);
  if (!(cap >= floor)) return { ok: false, why: '最低出价已高于经济上限或预算', maxBid, cap, floor };
  const wanted = floor * (1 + uplift / 100);
  let bid = Math.min(wanted, cap);
  bid = Math.floor(bid * 1e6 + 1e-9) / 1e6;
  if (bid + 1e-8 < floor) bid = floor;
  if (bid - cap > 1e-6) return { ok: false, why: '出价高于上限', maxBid, cap, bid };
  const total = bid + nonCompute;
  if (!(total > 0) || !Number.isFinite(total)) return { ok: false, why: '出价后的总费用无效' };
  const roi = (rev - total) / total * 100;
  if (!(roi + 1e-6 >= target)) return { ok: false, why: '出价后的收益率低于目标', roi, bid, total, maxBid, cap };
  return { ok: true, bid, total, roi, maxBid, cap, floor, wanted };
}

export function rankByHashPerDollar(offers) {
  return [...offers].sort((a, b) =>
    (b.thPerDollar - a.thPerDollar)
    || (b.roi - a.roi)
    || (a.dph - b.dph)
    || String(a.id).localeCompare(String(b.id)));
}

// 所有「有算力、按当前收益有可能达到目标」的型号。不写死 4070S / 4070Ti / 5090。
export function viableModelKeys(table, usdPerHsHour, targetProfitPct, minGpuPrice) {
  const usd = finiteNum(usdPerHsHour);
  const t = finiteNum(targetProfitPct);
  if (!(usd > 0) || t == null) return [];
  return table
    .filter(g => g.autoOk && g.effective * 1e12 * usd / (1 + t / 100) >= minGpuPrice)
    .map(g => g.key);
}

// 每个型号单独按最低时租取一小页，再由调用方按算力/美元排序。
// 一轮的请求数和条数都有上限，型号多时轮转，避免某一轮的 FLOPS 或卡数把便宜型号挤掉。
export function modelProbePlan({ modelNames, scanRows, maxProbes, cursor }) {
  const rows = Math.max(1, scanRows | 0);
  const names = (modelNames || []).filter(m => m?.names?.length);
  if (!names.length) return { probes: [], nextCursor: cursor || 0, broad: true, per: rows };
  const cap = Math.max(1, Math.min(maxProbes || 8, names.length, rows));
  const start = ((cursor || 0) % names.length + names.length) % names.length;
  const picked = [];
  for (let i = 0; i < cap; i++) picked.push(names[(start + i) % names.length]);
  const per = Math.max(1, Math.floor(rows / picked.length));
  return {
    probes: picked.map(m => ({ key: m.key, names: m.names.slice(0, 8), limit: per })),
    nextCursor: (start + picked.length) % names.length,
    broad: false,
    per,
  };
}

// 热扫描只在「收益上升且还有租用空间」或「新出现达标报价」时打开。
// 收益下降、新低价、行情过期、持平、冷却中、没有租用空间，都不打开。
export function hotDecision(s) {
  if (s.coolUntil && s.now < s.coolUntil) return { arm: false, why: '热扫描冷却中' };
  if (!s.roomToRent) return { arm: false, why: '没有租用空间' };
  if (s.badMarket || !s.fresh || !(finiteNum(s.usd) > 0)) return { arm: false, why: '行情不新鲜或无效' };
  const prev = finiteNum(s.prevUsd);
  const usd = s.usd;
  if (prev > 0 && usd < prev * (1 - 1e-9)) return { arm: false, why: '收益下降，不因降价加速', mark: true };
  const up = prev > 0 ? (usd - prev) / prev * 100 : 0;
  const need = finiteNum(s.upPct) ?? 3;
  if (prev > 0 && up + 1e-9 >= need) return { arm: true, why: `收益上升 ${up.toFixed(1)}% 且仍有租用空间`, mark: true };
  if ((s.qualifyingFresh | 0) > 0) return { arm: true, why: `新出现 ${s.qualifyingFresh} 个达标报价` };
  if (prev > 0 && Math.abs(up) < 0.5) return { arm: false, why: '行情持平' };
  return { arm: false, why: '' };
}

// 额度分摊的间隔永远优先于热扫描：热窗口不能把扫描加快到额度撑不住的程度。
export function resolveScanInterval({ baseMs, fastMs, hotActive, quotaPaceMs }) {
  let interval = baseMs;
  let why = '';
  if (quotaPaceMs != null && quotaPaceMs > interval) {
    interval = quotaPaceMs;
    why = 'quota';
  }
  if (hotActive) {
    const fast = Math.max(fastMs, quotaPaceMs || 0);
    if (fast + 1 < interval) {
      interval = fast;
      why = 'hot';
    } else if (quotaPaceMs != null && quotaPaceMs > fastMs) why = 'quota-blocks-hot';
  }
  return { interval, why };
}

// 正数底线 = 收益率低于该底线就退出，不是「允许亏这么多」。
// 预热只挡住算力爬坡噪声。保守满算力仍然亏钱时走更短的退出，不在预热里一直耗着。
export function profitFloorDecision(s) {
  const floor = s.floorPct;
  // 费用未知时只停住，不按亏损退出。未知不能当成 0 元成本。
  if (!s.costKnown || !(finiteNum(s.costHr) > 0)) return { action: 'hold', path: 'unknown-cost', reason: '费用未知，不按收益率退出' };
  const expNeg = s.marketFresh && Number.isFinite(s.expectedRoi) && s.expectedRoi < 0;
  if (expNeg && s.negForMin >= s.negExitMin) {
    return { action: 'exit', path: 'negative', reason: '即使按保守满算力，收益也覆盖不了已知成本' };
  }
  if (!s.marketFresh) {
    if (s.wasBelow && s.belowForMin >= s.persistMin) {
      return { action: 'exit', path: 'floor', reason: '利润低于底线，且行情中断前已经记满退出时间' };
    }
    return { action: 'hold', path: 'stale-market' };
  }
  if (s.sinceHashMin < s.warmupMin) return { action: expNeg ? 'arm-negative' : 'warmup', path: 'warmup' };
  if (!s.samplesOk || !Number.isFinite(s.sustainedRoi)) return { action: expNeg ? 'arm-negative' : 'hold', path: 'noise' };
  if (s.sustainedRoi < floor) {
    if (s.belowForMin >= s.persistMin) return { action: 'exit', path: 'floor', reason: '持续利润低于底线' };
    return { action: 'arm-floor', path: 'floor', alsoNegative: expNeg };
  }
  if (expNeg) return { action: 'arm-negative', path: 'negative' };
  return { action: 'clear', path: 'ok' };
}

export function sustainedStats(samples, now, resetAt, windowMs, staleMs) {
  const arr = (samples || []).filter(s => s && Number.isFinite(s.t) && Number.isFinite(s.hs) && s.t > (resetAt || 0) && now - s.t <= windowMs);
  if (!arr.length) return { ok: false, hs: null, newestAgeMs: Infinity, stale: true };
  const newest = arr[arr.length - 1].t;
  const oldest = arr[0].t;
  const newestAge = now - newest;
  if (newestAge > staleMs) return { ok: false, hs: null, newestAgeMs: newestAge, stale: true };
  if (arr.length < 4 || newest - oldest < Math.min(windowMs, 3 * 60 * 1000) * 0.5) {
    return { ok: false, hs: null, newestAgeMs: newestAge, stale: false };
  }
  const hs = arr.reduce((a, s) => a + s.hs, 0) / arr.length;
  if (!Number.isFinite(hs) || hs < 0) return { ok: false, hs: null, newestAgeMs: newestAge, stale: false };
  return { ok: true, hs, newestAgeMs: newestAge, stale: false };
}

// 已经租下的机器每小时要花多少。
// vast 实例上的 dph_total 是按需总价，不是可中断出价，也不是租客的合计成本。
// 本程序租的机器优先用下单时记下的出价（或按需算力价）加上当前仍有效的存储单价，
// 再加上配置里的流量上限。存储单价变了会反映到新的合计里。
// 可中断实例如果既没有有效出价、也没有下单时的合计，不能拿 dph_total 来冒充，也不能当成 0。
export function managedRunningCost(inst, managed, cfg) {
  const mode = managed?.rentMode;
  const saved = finiteNum(managed?.dph);
  const savedOk = saved != null && saved > 0;
  const bid = finiteNum(managed?.bid);
  const st = storageHourly(inst || {}, cfg?.disk);
  const bw = bandwidthHourly(inst || {}, cfg?.bandwidthGbPerHour ?? 0);
  if (!st.ok || !bw.ok) {
    if (mode === 'interruptible') return { ok: false, dph: null, storageHr: null, why: (!st.ok ? st.why : bw.why) || '费用无效' };
    if (savedOk) return { ok: true, dph: saved, storageHr: null, source: 'saved' };
    const listed = finiteNum(inst?.dph_total);
    if (listed != null && listed > 0) return { ok: true, dph: listed, storageHr: null, source: 'dph_total' };
    return { ok: false, dph: null, storageHr: null, why: '费用无效' };
  }
  const storageHr = st.known ? st.hr : null;
  const bandwidthHr = bw.known ? bw.hr : null;
  if (mode === 'interruptible') {
    if (bid != null && bid > 0 && storageHr != null && bandwidthHr != null) {
      const dph = bid + storageHr + bandwidthHr;
      if (dph > 0) return { ok: true, dph, storageHr, bandwidthHr, source: 'bid+storage+bandwidth' };
    }
    if (savedOk) return { ok: true, dph: saved, storageHr, bandwidthHr, source: 'saved' };
    return { ok: false, dph: null, storageHr, why: '可中断实例没有有效的出价或下单总费用' };
  }
  const gpu = finiteNum(inst?.search?.gpuCostPerHour);
  const base = finiteNum(inst?.dph_base);
  const compute = gpu != null && gpu > 0 ? gpu : (base != null && base > 0 ? base : null);
  if (compute != null && storageHr != null && bandwidthHr != null) {
    const dph = compute + storageHr + bandwidthHr;
    if (dph > 0) return { ok: true, dph, storageHr, bandwidthHr, source: 'compute+storage+bandwidth' };
  }
  if (savedOk) return { ok: true, dph: saved, storageHr, source: 'saved' };
  const listed = finiteNum(inst?.dph_total);
  if (listed != null && listed > 0) return { ok: true, dph: listed, storageHr, source: 'dph_total' };
  return { ok: false, dph: null, storageHr: null, why: '没有有效的时租' };
}

// 抢占是可中断实例的正常生命周期，不是硬件故障。
// 仍在 running / loading / created / scheduling 的机器不是抢占，哪怕状态文字里写了租用类型 "interruptible"。
export function isPreempted(inst, managed) {
  const actual = String(inst?.actual_status || '');
  if (actual === 'running' || actual === 'loading' || actual === 'created' || actual === 'scheduling') return false;
  const msg = `${inst?.status_msg || ''} ${inst?.cur_state || ''} ${inst?.next_state || ''}`;
  // "interrupted" 是已经发生的抢占。不要用能命中 "interruptible" 的子串。
  if (/outbid|preempt|bid too low|client bid|\binterrupted\b/i.test(msg)) return true;
  const stopped = inst?.intended_status === 'stopped' || /^(stopped|exited)$/i.test(actual);
  return !!(managed?.rentMode === 'interruptible' && stopped && actual);
}
