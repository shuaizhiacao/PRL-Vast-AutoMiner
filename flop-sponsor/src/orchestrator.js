import crypto from 'node:crypto';
import fs from 'node:fs';
import { executionMode, assertLive, assertLiveReady } from './config.js';
import { decideSeat } from './limits.js';
import { request } from './http.js';
import { writeSeatIntent } from './intent.js';
import { readPublicAddress } from './keys.js';
import { signForSubmit, sponsorBodyShape, sponsorMessage } from './sign.js';
import { submitSponsor, createRateLimiter, interpretSponsor, parseSponsorStdout } from './sponsor.js';
import {
  createClore, planOrder, redactOrder, classifyCreate, matchNewOrder, orderIdOf, parseSshEndpoint, confirmCancel, adoptableOrders,
} from './clore.js';
import { selectServers, profileOf, assessHardware } from './gpu.js';
import { loadState, saveState, transition } from './state.js';
import { backendFrom } from './backend.js';
import { maybeIdlePearl } from './pearl.js';
import { Invariant, Stop } from './errors.js';
import { redact } from './redact.js';
import { utcDay, CREATE_COOLDOWN_MS, nextUtcMidnight, readGraceHours, graceWindow } from './time.js';

function finish(mode, state, logs, pearl, extra = {}) {
  return {
    mode,
    phase: state.phase,
    state,
    logs,
    pearl,
    stopped: extra.stopped === true || state.phase === 'FAILED' || state.phase === 'STOP_NEEDS_HUMAN',
    ...extra,
  };
}

async function fetchLimits(ctx) {
  try {
    const res = await request(ctx.cfg.limitsUrl, { fetchImpl: ctx.fetchImpl });
    if (!res.json || res.data == null) return { error: 'limits-not-json' };
    return { data: res.data };
  } catch {
    return { error: 'limits-network' };
  }
}

function previewOf(ctx, seat) {
  let address = '';
  if (ctx.cfg.addressFile) {
    try { address = readPublicAddress(ctx.cfg.addressFile); } catch { address = ''; }
  }
  const issuedAt = String(ctx.now());
  const message = ctx.genesisVerified === true && ctx.genesis && address
    ? sponsorMessage({ genesis: ctx.genesis, address, issuedAt })
    : null;
  let order;
  try {
    order = redactOrder(planOrder({
      serverId: 0,
      image: ctx.cfg.clore.image,
      currency: ctx.cfg.clore.currency,
      tag: 'flop-preview',
      rentalHours: ctx.cfg.clore.rentalHours,
      autoRenew: ctx.cfg.clore.autoRenew === true,
      autoRenewMaxPrice: ctx.cfg.clore.autoRenewMaxPrice,
      publicKey: '',
    }));
  } catch (e) {
    order = { error: e.message };
  }
  return { message, bodyShape: sponsorBodyShape(address), order, graceHours: seat.graceHours, backend: backendFrom(ctx.cfg).plan() };
}

function cloreOf(ctx, state) {
  return ctx.clore || createClore({
    baseUrl: ctx.cfg.clore.baseUrl,
    apiKey: ctx.env?.CLORE_API_KEY || '',
    fetchImpl: ctx.fetchImpl,
    now: ctx.now,
    sleep: ctx.sleep,
    lastCreateAt: state.rent?.lastCreateAt || 0,
  });
}

async function refreshSeat(ctx, state) {
  const limits = await fetchLimits(ctx);
  if (limits.error) return { state, seat: { action: 'wait', reason: limits.error } };
  const seat = decideSeat(limits.data, ctx.cfg, ctx.now());
  if (seat.action !== 'pass') {
    return { state: { ...state, seat: { ok: false } }, seat };
  }
  const intent = writeSeatIntent(ctx.stateDir, seat, ctx.now(), ctx.cfg.seatTtlMs);
  return {
    state: { ...state, seat: { ok: true, expiresAt: intent.expiresAt, graceHours: seat.graceHours, at: ctx.now() } },
    seat,
  };
}

function needsHuman(state, reason, now) {
  const failure = { reason, needsHuman: true };
  if (state.phase === 'STOP_NEEDS_HUMAN') return { ...state, failure };
  return transition(state, 'STOP_NEEDS_HUMAN', { failure }, now, reason);
}

async function readGrace(ctx, state) {
  const limits = await fetchLimits(ctx);
  return readGraceHours(limits.data, state.sponsor?.graceHours ?? ctx.cfg.graceHoursDefault ?? 4);
}

function withinGrace(ctx, state, graceHours) {
  return graceWindow({
    sponsoredAt: state.sponsor?.sponsoredAt,
    graceHours,
    bootEstimateMs: ctx.cfg.bootEstimateMs,
    calibrateEstimateMs: ctx.cfg.calibrateEstimateMs,
    now: ctx.now(),
  });
}

async function sponsorOnce(ctx, state, log) {
  assertLive(ctx.cfg, ctx.env);
  if (ctx.genesisVerified !== true) throw new Invariant('未校验 genesis 不签');
  const cfg = ctx.cfg;
  if (cfg.signMode === 'sponsor-sh') return sponsorViaScript(ctx, state, log);
  if (!cfg.signerFile) throw new Stop('未配置 signerFile');
  const expected = cfg.addressFile ? readPublicAddress(cfg.addressFile) : '';
  const issuedAt = String(ctx.now());
  const signed = await signForSubmit({
    signerFile: cfg.signerFile,
    genesis: ctx.genesis,
    issuedAt,
    genesisVerified: true,
  });
  if (expected && signed.address !== expected) throw new Stop('密钥推导的地址与地址文件不一致');
  log(`已本地签名，地址 ${signed.address}，签名不写日志`);
  const limiter = ctx.limiter || createRateLimiter({ now: ctx.now, sleep: ctx.sleep });
  const url = cfg.sponsorMode === 'review' ? cfg.review.submitUrl : cfg.sponsorUrl;
  const posted = await submitSponsor({
    body: { address: signed.address, issuedAt: signed.issuedAt, signature: signed.signature },
    limiter,
    sleep: ctx.sleep,
    post: (body) => request(url, { method: 'POST', body, fetchImpl: ctx.fetchImpl }),
  });
  return { signed, posted };
}

async function sponsorViaScript(ctx, state, log) {
  assertLive(ctx.cfg, ctx.env);
  if (!ctx.cfg.sponsorSh) throw new Stop('signMode=sponsor-sh 但没有官方 sponsor.sh 路径');
  if (typeof ctx.spawn !== 'function') throw new Stop('没有 sponsor.sh 执行器');
  if (ctx.genesisVerified !== true) throw new Invariant('未校验 genesis 不签');
  log('调用官方 sponsor.sh，参数只有脚本路径和密钥文件路径');
  const out = await ctx.spawn(ctx.cfg.sponsorSh, [ctx.cfg.signerFile]);
  const parsed = parseSponsorStdout(out.stdout || '');
  if (!parsed) throw new Stop('sponsor.sh 没有给出可识别的 HTTP 状态，拒绝猜测');
  const decision = interpretSponsor(parsed.status, parsed.body || {});
  return {
    signed: { address: parsed.address },
    posted: { status: parsed.status, data: parsed.body || {}, decision },
  };
}

async function applySponsor(ctx, state, log) {
  const day = utcDay(ctx.now());
  if (state.sponsor?.done) return { state };
  if (state.sponsor?.closed && state.sponsor?.attemptedDay === day && state.phase === 'SEAT_CHECK') {
    return { state, waitUntil: nextUtcMidnight(ctx.now()), waitReason: 'daily-application' };
  }
  let current = state;
  if (current.phase === 'SEAT_CHECK') {
    current = transition(current, 'SPONSOR_SIGN', {
      sponsor: { ...current.sponsor, attemptedDay: day },
    }, ctx.now(), '开始签名');
    saveState(ctx.stateDir, current);
  }
  if (current.phase === 'SPONSOR_SIGN') {
    current = transition(current, 'SPONSOR_SUBMIT', {
      sponsor: { ...current.sponsor, attemptedDay: day },
    }, ctx.now(), '提交前先落盘，避免并发 POST');
    saveState(ctx.stateDir, current);
  }
  let retries = 0;
  for (;;) {
    const { signed, posted } = await sponsorOnce(ctx, current, log);
    const decision = posted.decision;
    current = { ...current, sponsor: { ...current.sponsor, address: signed.address, attemptedDay: day } };
    if (decision.action === 'ok') {
      current = transition(current, 'SPONSORED', {
        sponsor: {
          done: true,
          address: signed.address,
          httpStatus: posted.status,
          reason: decision.reason,
          attemptedDay: day,
          sponsoredAt: ctx.now(),
          graceHours: current.seat?.graceHours ?? ctx.cfg.graceHoursDefault,
        },
      }, ctx.now(), decision.reason);
      saveState(ctx.stateDir, current);
      return { state: current };
    }
    if (decision.action === 'stop') {
      current = transition(current, 'FAILED', {
        failure: { reason: decision.reason },
        sponsor: { ...current.sponsor, closed: true, address: signed.address },
      }, ctx.now(), decision.reason);
      saveState(ctx.stateDir, current);
      return { state: current };
    }
    retries += 1;
    if (retries > ctx.cfg.maxSponsorRetries) {
      current = transition(current, 'FAILED', {
        failure: { reason: 'sponsor-retries-exhausted' },
        sponsor: { ...current.sponsor, closed: true },
      }, ctx.now(), '赞助重试次数用尽');
      saveState(ctx.stateDir, current);
      return { state: current };
    }
    const waitMs = decision.waitMs ?? ctx.cfg.retry503Ms;
    log(`赞助 ${decision.reason}，等待 ${waitMs}ms 后用同一地址重试`);
    await ctx.sleep(waitMs);
    const again = await refreshSeat(ctx, current);
    current = again.state;
    saveState(ctx.stateDir, current);
    if (again.seat.action !== 'pass') {
      return { state: current, waitUntil: again.seat.until || null, waitReason: again.seat.reason };
    }
  }
}

async function reconcileOnce(ctx, state) {
  let listed;
  try {
    listed = await cloreOf(ctx, state).myOrders();
  } catch {
    return { ...state, rent: { ...state.rent, reconciledEmpty: false, reconcileError: true } };
  }
  const hits = matchNewOrder(listed.data?.orders, {
    serverId: state.rent.serverId,
    intentAtSec: state.rent.intentAtSec,
  });
  if (hits.length > 1) {
    return needsHuman({ ...state, rent: { ...state.rent, reconciledEmpty: false } }, 'reconcile-ambiguous', ctx.now());
  }
  if (hits.length === 1) {
    const id = orderIdOf(hits[0]);
    if (id == null) return needsHuman(state, 'order-without-id', ctx.now());
    return transition(state, 'RENTED', {
      rent: { ...state.rent, orderId: id, ssh: parseSshEndpoint(hits[0]), reconciledEmpty: false },
    }, ctx.now(), `对账到订单 ${id}`);
  }
  return { ...state, rent: { ...state.rent, reconciledEmpty: true, reconcileError: false } };
}

async function reconcileUntil(ctx, state, log) {
  const budget = Number(ctx.cfg.reconcileBudgetMs) > 0 ? Number(ctx.cfg.reconcileBudgetMs) : 180_000;
  const started = ctx.now();
  let current = state;
  for (;;) {
    current = await reconcileOnce(ctx, current);
    saveState(ctx.stateDir, current);
    if (current.phase !== 'RENT_UNKNOWN') return current;
    if (ctx.now() - started + CREATE_COOLDOWN_MS > budget) break;
    const before = ctx.now();
    await ctx.sleep(CREATE_COOLDOWN_MS);
    if (ctx.now() === before) throw new Stop('对账时钟没有前进，停止以免空转');
  }
  log('对账窗口结束仍没有订单，停止并交给人，不再下单');
  current = needsHuman(current, 'reconcile-not-found', ctx.now());
  saveState(ctx.stateDir, current);
  return current;
}

function adoptOrder(state, order, now) {
  const id = orderIdOf(order);
  const rent = { ...state.rent, orderId: id, ssh: parseSshEndpoint(order), adopted: true, serverId: order.si ?? state.rent?.serverId };
  let current = state;
  if (current.phase === 'SPONSORED') current = transition(current, 'RENT_INTENT', { rent }, now, '接管已有订单');
  if (current.phase === 'RENT_INTENT') current = transition(current, 'RENT_UNKNOWN', { rent }, now, '接管前记账');
  if (current.phase === 'RENT_UNKNOWN') return transition(current, 'RENTED', { rent }, now, `接管订单 ${id}`);
  return current;
}

async function sendCreate(ctx, state, log) {
  assertLive(ctx.cfg, ctx.env);
  const cfg = ctx.cfg;
  const graceHours = await readGrace(ctx, state);
  const window = withinGrace(ctx, { ...state, sponsor: { ...state.sponsor, graceHours } }, graceHours);
  if (!window.ok) {
    log(`校准窗口不够：剩余 ${window.remain ?? '未知'}ms，开机加校准需要 ${window.need ?? '未知'}ms`);
    const stopped = needsHuman(state, window.reason, ctx.now());
    saveState(ctx.stateDir, stopped);
    return { state: stopped };
  }
  if (state.rent?.createSubmitted === true) {
    log('状态里已有一次下单标记，不再 create_order');
    return { state: await reconcileUntil(ctx, state.phase === 'RENT_UNKNOWN' ? state : state, log) };
  }
  const clore = cloreOf(ctx, state);
  const listed = await clore.myOrders();
  const existing = adoptableOrders(listed.data?.orders, { orderId: state.rent?.orderId, tag: state.rent?.tag });
  if (existing.length > 1) {
    const stopped = needsHuman(state, 'multiple-active-orders', ctx.now());
    saveState(ctx.stateDir, stopped);
    return { state: stopped };
  }
  if (existing.length === 1) {
    log('账户里已有符合条件的活跃订单，直接接管，不下新单');
    const adopted = adoptOrder(state, existing[0], ctx.now());
    saveState(ctx.stateDir, adopted);
    return { state: adopted };
  }
  const market = await clore.marketplace();
  const servers = selectServers(market.data?.servers, {
    profile: profileOf(cfg),
    currency: cfg.clore.currency,
    maxUsdPerHour: Number(cfg.maxUsdPerHour),
    rankBy: cfg.rankBy,
  });
  if (!servers.length) return { state, waitReason: 'no-server' };
  const server = servers[0];
  const tag = state.rent?.tag || `flop-${crypto.randomBytes(4).toString('hex')}`;
  if (typeof ctx.sshKeys !== 'function') throw new Stop('缺少 SSH 公钥生成器');
  const keys = await ctx.sshKeys();
  const publicKey = String(keys?.publicKey || '').trim();
  if (!publicKey || publicKey.includes('\n')) throw new Stop('SSH 公钥无效');
  const body = planOrder({
    serverId: server.id,
    image: cfg.clore.image,
    currency: cfg.clore.currency,
    tag,
    rentalHours: Number(cfg.maxRentHours),
    autoRenew: cfg.clore.autoRenew === true,
    autoRenewMaxPrice: cfg.clore.autoRenewMaxPrice,
    publicKey,
  });
  log(`create_order 正文已组好，ssh 材料不写日志：${JSON.stringify(redactOrder(body))}`);
  const last = state.rent?.lastCreateAt || 0;
  const wait = CREATE_COOLDOWN_MS - (ctx.now() - last);
  if (last && wait > 0) await ctx.sleep(wait);
  const intentAtSec = Math.floor(ctx.now() / 1000);
  const rent = {
    ...state.rent,
    tag,
    serverId: server.id,
    intentAtSec,
    lastCreateAt: ctx.now(),
    createSubmitted: true,
    unknownReason: 'inflight',
    reconciledEmpty: false,
  };
  let current = state;
  if (current.phase === 'SPONSORED') current = transition(current, 'RENT_INTENT', { rent }, ctx.now(), '准备下单');
  if (current.phase === 'RENT_INTENT') {
    current = transition(current, 'RENT_UNKNOWN', { rent }, ctx.now(), '下单标记已落盘，只允许这一次请求');
  } else {
    current = { ...current, rent };
  }
  saveState(ctx.stateDir, current);
  assertLive(ctx.cfg, ctx.env);
  let res;
  try {
    res = await clore.createOrder(body);
  } catch (e) {
    current = { ...current, rent: { ...current.rent, unknownReason: 'timeout', lastCreateAt: ctx.now(), createSubmitted: true } };
    saveState(ctx.stateDir, current);
    log(redact(e.message || 'create_order 超时'));
    return { state: await reconcileUntil(ctx, current, log) };
  }
  const classified = classifyCreate(res);
  if (classified.kind === 'rejected') {
    current = transition(current, 'FAILED', {
      failure: { reason: 'create-rejected', detail: classified.error },
      rent: { ...current.rent, lastCreateAt: ctx.now(), createSubmitted: true },
    }, ctx.now(), classified.error);
    saveState(ctx.stateDir, current);
    return { state: current };
  }
  current = {
    ...current,
    rent: { ...current.rent, unknownReason: classified.kind === 'accepted' ? 'code0' : 'bad-body', lastCreateAt: ctx.now(), createSubmitted: true },
  };
  saveState(ctx.stateDir, current);
  return { state: await reconcileUntil(ctx, current, log) };
}

async function resumeUnknown(ctx, state, log) {
  assertLive(ctx.cfg, ctx.env);
  log('RENT_UNKNOWN 只对账，不提交新的 create_order');
  return { state: await reconcileUntil(ctx, state, log) };
}

async function bootstrap(ctx, state, log) {
  assertLive(ctx.cfg, ctx.env);
  let current = state.phase === 'RENTED'
    ? transition(state, 'BOOTSTRAP', {}, ctx.now(), '开始核验硬件')
    : state;
  saveState(ctx.stateDir, current);
  if (!current.rent?.hardwareChecked) {
    assertLive(ctx.cfg, ctx.env);
    const ssh = typeof ctx.ssh === 'function' ? ctx.ssh(current.rent.ssh) : ctx.ssh;
    if (typeof ssh?.exec !== 'function') throw new Stop('没有 SSH 执行器，无法核验显存');
    const smi = await ssh.exec('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits');
    const disk = await ssh.exec('df -BG /');
    const hw = assessHardware({ smiText: smi, diskText: disk, profile: profileOf(ctx.cfg) });
    if (!hw.ok) {
      current = transition(current, 'FAILED', {
        failure: { reason: hw.reason },
        rent: { ...current.rent, hardwareChecked: true, hardwareOk: false },
      }, ctx.now(), hw.reason);
      if (ctx.cfg.autoCancelOnFail === true) {
        assertLive(ctx.cfg, ctx.env);
        const cancel = await confirmCancel(cloreOf(ctx, current), current.rent.orderId);
        current = { ...current, rent: { ...current.rent, cancel } };
        log(cancel.done ? '不达标，已确认订单离开活动列表' : '取消请求未确认完成，订单可能仍在计费');
      } else {
        log('硬件不达标。autoCancelOnFail 为 false，不退租');
      }
      saveState(ctx.stateDir, current);
      return current;
    }
    current = { ...current, rent: { ...current.rent, hardwareChecked: true, hardwareOk: true } };
    saveState(ctx.stateDir, current);
  }
  if (current.phase === 'FAILED') return current;
  if (!current.bootstrap?.started) {
    assertLive(ctx.cfg, ctx.env);
    const backend = backendFrom(ctx.cfg);
    const result = await backend.start({
      orderId: current.rent.orderId,
      serverId: current.rent.serverId,
      ssh: current.rent.ssh || null,
      tag: current.rent.tag,
    });
    const safe = { ok: result?.ok === true, ready: result?.ready === true, unresolved: result?.unresolved || [] };
    if (!safe.ok) {
      current = transition(current, 'FAILED', {
        failure: { reason: 'backend-unresolved', unresolved: safe.unresolved },
        bootstrap: { started: true },
      }, ctx.now(), 'backend 接口拒绝启动');
      log('backend 未启动。订单不自动取消');
      saveState(ctx.stateDir, current);
      return current;
    }
    current = transition(current, 'CALIBRATE', { bootstrap: { started: true } }, ctx.now(), '进入校准');
    if (safe.ready) current = transition(current, 'READY', {}, ctx.now(), 'backend 报告就绪');
    saveState(ctx.stateDir, current);
  }
  return current;
}

export async function runOnce(ctx) {
  const mode = executionMode(ctx.cfg, ctx.env || {});
  const logs = [];
  const log = (line) => logs.push(redact(line));
  let state = loadState(ctx.stateDir);

  if (mode === 'dry' && state.phase !== 'SEAT_CHECK') {
    log(`DRY 只输出已保存的状态 ${state.phase}，不对账、不下单、不连接机器`);
    return finish(mode, state, logs, null, { dry: true, readOnly: true });
  }
  if (ctx.cfg.sponsorMode === 'review' && !ctx.cfg.review?.submitUrl) {
    throw new Stop('review 模式的提交地址没有配置。官方测试网申请入口尚未公布，脚本不会猜测 URL。');
  }
  if (mode === 'live') assertLiveReady(ctx.cfg);

  if (state.phase === 'FAILED' || state.phase === 'STOP_NEEDS_HUMAN') {
    return finish(mode, state, logs, null, { stopped: true, reason: state.failure?.reason });
  }
  if (state.phase === 'READY') {
    return finish(mode, state, logs, maybeIdlePearl({ minerReady: true, flopSessionActive: null }));
  }
  if (state.phase === 'RENT_UNKNOWN') {
    const resumed = await resumeUnknown(ctx, state, log);
    state = resumed.state;
    if (state.phase === 'RENTED' || state.phase === 'BOOTSTRAP') state = await bootstrap(ctx, state, log);
    const pearl = state.phase === 'CALIBRATE' || state.phase === 'READY'
      ? maybeIdlePearl({ minerReady: state.phase === 'READY', flopSessionActive: null }) : null;
    return finish(mode, state, logs, pearl, { waitUntil: resumed.waitUntil, waitReason: resumed.waitReason });
  }
  if (state.phase === 'RENTED' || state.phase === 'BOOTSTRAP' || state.phase === 'CALIBRATE') {
    if (state.phase !== 'CALIBRATE') state = await bootstrap(ctx, state, log);
    const pearl = state.phase === 'CALIBRATE' || state.phase === 'READY'
      ? maybeIdlePearl({ minerReady: state.phase === 'READY', flopSessionActive: null }) : null;
    return finish(mode, state, logs, pearl);
  }

  if (state.sponsor?.done && (state.phase === 'SPONSORED' || state.phase === 'RENT_INTENT')) {
    const rented = await sendCreate(ctx, state, log);
    state = rented.state;
    if (state.phase === 'RENTED' || state.phase === 'BOOTSTRAP') state = await bootstrap(ctx, state, log);
    const pearl = state.phase === 'CALIBRATE' || state.phase === 'READY'
      ? maybeIdlePearl({ minerReady: state.phase === 'READY', flopSessionActive: null }) : null;
    return finish(mode, state, logs, pearl, { waitReason: rented.waitReason || null });
  }

  const refreshed = await refreshSeat(ctx, state);
  state = refreshed.state;
  saveState(ctx.stateDir, state);
  if (refreshed.seat.action === 'stop') {
    return finish(mode, state, logs, null, { stopped: true, reason: refreshed.seat.reason, seat: refreshed.seat });
  }
  if (refreshed.seat.action !== 'pass') {
    return finish(mode, state, logs, null, { seat: refreshed.seat, waitUntil: refreshed.seat.until || null, waitReason: refreshed.seat.reason });
  }
  const preview = previewOf(ctx, refreshed.seat);
  if (preview.message) log(`签名消息原文：${preview.message}`);
  else log('创世哈希未校验或还没有矿工地址，不打印可签名消息');
  log(`将要 POST 的正文形状：${JSON.stringify(preview.bodyShape)}`);
  log(`将要下单的正文：${JSON.stringify(preview.order)}`);

  if (mode === 'dry') return finish(mode, state, logs, null, { dry: true, seat: refreshed.seat, preview });

  if (!state.sponsor?.done) {
    const applied = await applySponsor(ctx, state, log);
    state = applied.state;
    saveState(ctx.stateDir, state);
    if (applied.waitReason) {
      return finish(mode, state, logs, null, { waitUntil: applied.waitUntil || null, waitReason: applied.waitReason, seat: refreshed.seat, preview });
    }
  }
  if (state.phase === 'FAILED') return finish(mode, state, logs, null, { stopped: true, reason: state.failure?.reason, preview });
  if (ctx.cfg.sponsorMode === 'review' && !reviewApproved(ctx.cfg)) {
    log('审查申请已处理。批准文件出现之前不租机');
    return finish(mode, state, logs, null, { waitingApproval: true, seat: refreshed.seat, preview });
  }
  if (state.phase === 'SPONSORED' || state.phase === 'RENT_INTENT') {
    const rented = await sendCreate(ctx, state, log);
    state = rented.state;
    if (rented.waitReason) return finish(mode, state, logs, null, { waitReason: rented.waitReason, preview });
  }
  if (state.phase === 'RENTED' || state.phase === 'BOOTSTRAP') state = await bootstrap(ctx, state, log);
  const pearl = state.phase === 'CALIBRATE' || state.phase === 'READY'
    ? maybeIdlePearl({ minerReady: state.phase === 'READY', flopSessionActive: null }) : null;
  return finish(mode, state, logs, pearl, { seat: refreshed.seat, preview });
}

function reviewApproved(cfg) {
  if (!cfg.review?.approvedFile) return false;
  try {
    return fs.existsSync(cfg.review.approvedFile) && fs.readFileSync(cfg.review.approvedFile, 'utf8').trim() !== '';
  } catch { return false; }
}
