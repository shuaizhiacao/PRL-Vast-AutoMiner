import crypto from 'node:crypto';
import fs from 'node:fs';
import { executionMode } from './config.js';
import { decideSeat } from './limits.js';
import { request } from './http.js';
import { writeSeatIntent } from './intent.js';
import { readPublicAddress } from './keys.js';
import { signForSubmit, sponsorBodyShape, sponsorMessage } from './sign.js';
import { submitSponsor, createRateLimiter, interpretSponsor, parseSponsorStdout } from './sponsor.js';
import {
  createClore, planOrder, redactOrder, classifyCreate, matchNewOrder, orderIdOf, parseSshEndpoint, confirmCancel,
} from './clore.js';
import { filterServers, profileOf, assessHardware } from './gpu.js';
import { loadState, saveState, transition } from './state.js';
import { backendFrom } from './backend.js';
import { maybeIdlePearl } from './pearl.js';
import { Invariant, Stop } from './errors.js';
import { redact } from './redact.js';
import { utcDay, CREATE_COOLDOWN_MS, nextUtcMidnight } from './time.js';

function finish(mode, state, logs, pearl, extra = {}) {
  return {
    mode,
    phase: state.phase,
    state,
    logs,
    pearl,
    stopped: extra.stopped === true || state.phase === 'FAILED',
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

function assertSeat(state, nowMs) {
  if (state.seat?.ok !== true || !(state.seat.expiresAt > nowMs)) throw new Invariant('无 SEAT_OK 不租');
}

async function sponsorOnce(ctx, state, log) {
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
        sponsor: { done: true, address: signed.address, httpStatus: posted.status, reason: decision.reason, attemptedDay: day },
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

async function reconcile(ctx, state) {
  let listed;
  try {
    listed = await cloreOf(ctx, state).myOrders();
  } catch {
    return state;
  }
  const hits = matchNewOrder(listed.data?.orders, {
    serverId: state.rent.serverId,
    intentAtSec: state.rent.intentAtSec,
  });
  if (hits.length > 1) {
    return transition(state, 'FAILED', {
      failure: { reason: 'reconcile-ambiguous' },
      rent: { ...state.rent, reconciledEmpty: false },
    }, ctx.now(), '对账窗口里有多笔订单');
  }
  if (hits.length === 1) {
    const id = orderIdOf(hits[0]);
    if (id == null) {
      return transition(state, 'FAILED', { failure: { reason: 'order-without-id' } }, ctx.now(), '订单没有 id');
    }
    return transition(state, 'RENTED', {
      rent: { ...state.rent, orderId: id, ssh: parseSshEndpoint(hits[0]), reconciledEmpty: false },
    }, ctx.now(), `对账到订单 ${id}`);
  }
  return { ...state, rent: { ...state.rent, reconciledEmpty: true } };
}

async function sendCreate(ctx, state, log) {
  assertSeat(state, ctx.now());
  const cfg = ctx.cfg;
  const clore = cloreOf(ctx, state);
  const market = await clore.marketplace();
  const servers = filterServers(market.data?.servers, profileOf(cfg), cfg.clore.currency);
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
    rentalHours: cfg.clore.rentalHours,
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
    createAttempts: (state.rent?.createAttempts || 0) + 1,
    unknownReason: 'inflight',
    reconciledEmpty: false,
  };
  let current = { ...state, rent };
  if (state.phase === 'SPONSORED') {
    current = transition(state, 'RENT_INTENT', { rent }, ctx.now(), '准备下单');
  }
  if (current.phase === 'RENT_INTENT') {
    current = transition(current, 'RENT_UNKNOWN', { rent }, ctx.now(), '下单进入未知，先记账再请求');
  }
  saveState(ctx.stateDir, current);
  let res;
  try {
    res = await clore.createOrder(body);
  } catch (e) {
    current = { ...current, rent: { ...current.rent, unknownReason: 'timeout', lastCreateAt: ctx.now() } };
    saveState(ctx.stateDir, current);
    log(redact(e.message || 'create_order 超时'));
    const checked = await reconcile(ctx, current);
    saveState(ctx.stateDir, checked);
    return { state: checked };
  }
  const classified = classifyCreate(res);
  if (classified.kind === 'rejected') {
    current = transition(current, 'FAILED', {
      failure: { reason: 'create-rejected', detail: classified.error },
      rent: { ...current.rent, lastCreateAt: ctx.now() },
    }, ctx.now(), classified.error);
    saveState(ctx.stateDir, current);
    return { state: current };
  }
  current = {
    ...current,
    rent: { ...current.rent, unknownReason: classified.kind === 'accepted' ? 'code0' : 'bad-body', lastCreateAt: ctx.now() },
  };
  const checked = await reconcile(ctx, current);
  saveState(ctx.stateDir, checked);
  return { state: checked };
}

async function resumeUnknown(ctx, state, log) {
  const already = state.rent?.reconciledEmpty === true;
  let current = await reconcile(ctx, state);
  saveState(ctx.stateDir, current);
  if (current.phase !== 'RENT_UNKNOWN') return { state: current };
  if (!already) {
    log('本轮对账完成前不重下订单');
    return { state: current };
  }
  const reason = current.rent?.unknownReason;
  const retryable = reason === 'timeout' || reason === 'inflight' || reason === 'bad-body';
  if (reason === 'code0' || current.rent?.retried || !retryable) {
    log('对账仍没有订单。code 0 或已经重试过的未知下单不会再 create_order');
    return { state: current };
  }
  const seat = await refreshSeat(ctx, current);
  current = seat.state;
  if (seat.seat.action !== 'pass') return { state: current, waitUntil: seat.seat.until || null, waitReason: seat.seat.reason };
  current = { ...current, rent: { ...current.rent, retried: true } };
  saveState(ctx.stateDir, current);
  return sendCreate(ctx, current, log);
}

async function bootstrap(ctx, state, log) {
  let current = state.phase === 'RENTED'
    ? transition(state, 'BOOTSTRAP', {}, ctx.now(), '开始核验硬件')
    : state;
  saveState(ctx.stateDir, current);
  if (!current.rent?.hardwareChecked) {
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
  if (ctx.cfg.sponsorMode === 'review' && !ctx.cfg.review?.submitUrl) {
    throw new Stop('review 模式的提交地址没有配置。官方测试网申请入口尚未公布，脚本不会猜测 URL。');
  }
  let state = loadState(ctx.stateDir);

  if (state.phase === 'FAILED') return finish(mode, state, logs, null, { stopped: true, reason: state.failure?.reason });
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
    assertSeat(state, ctx.now());
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
