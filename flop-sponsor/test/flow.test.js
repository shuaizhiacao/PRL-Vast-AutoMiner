import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runOnce } from '../src/orchestrator.js';
import { executionMode, DEVNET_GENESIS } from '../src/config.js';
import { saveState, blankState } from '../src/state.js';
import { createSignerFile } from '../src/keys.js';
import { ADDRESS, clock, mockFetch, readFixture, serverGood, tempDir, testConfig } from './helpers.js';

function ctxOf(dir, fetchImpl, extra = {}) {
  const time = extra.clock || clock();
  const cfg = testConfig(dir, extra.cfg || {});
  if ((extra.env || {}).FLOP_CONFIRM_LIVE === '1') {
    if (extra.cfg?.maxUsdPerHour === undefined) cfg.maxUsdPerHour = 5;
    if (extra.cfg?.maxRentHours === undefined) cfg.maxRentHours = 4;
  }
  return {
    time,
    cfg,
    run(more = {}) {
      return runOnce({
        cfg,
        env: extra.env || {},
        fetchImpl,
        now: time.now,
        sleep: time.sleep,
        stateDir: dir,
        genesis: DEVNET_GENESIS,
        genesisVerified: extra.genesisVerified !== false,
        sshKeys: async () => ({ publicKey: 'ssh-ed25519 AAAATEST flop' }),
        ssh: { exec: async (cmd) => (cmd.includes('nvidia') ? '24576\n' : '400GB\n') },
        backend: extra.backend,
        ...more,
      });
    },
  };
}

describe('编排', { concurrency: 1 }, () => {
  test('DRY 只读 limits，打印消息原文和正文形状，不发写请求', async () => {
    const dir = tempDir();
    const { fetchImpl, calls } = mockFetch(async (call) => {
      if (call.method !== 'GET') throw new Error(`DRY 发出了 ${call.method}`);
      return { body: readFixture('limits-open') };
    });
    const box = ctxOf(dir, fetchImpl);
    const result = await box.run();
    assert.equal(result.dry, true);
    assert.equal(result.phase, 'SEAT_CHECK');
    assert.match(result.logs.join('\n'), new RegExp(`flop-sponsor/v1\\|miner\\|${DEVNET_GENESIS}\\|${ADDRESS}\\|`));
    assert.match(result.logs.join('\n'), /不在 DRY 生成/);
    assert.equal(calls.some(c => c.method === 'POST'), false);
    assert.equal(JSON.stringify(result.logs).includes('AAAATEST'), false);
  });

  test('LIVE 缺少双开关时拒绝，且不请求网络', async () => {
    const dir = tempDir();
    const { fetchImpl, calls } = mockFetch(async () => ({ body: {} }));
    const box = ctxOf(dir, fetchImpl, { cfg: { dryRun: false, autoApply: true, autoRent: false }, env: { FLOP_CONFIRM_LIVE: '1' } });
    await assert.rejects(() => box.run(), /拒绝写操作/);
    assert.equal(calls.length, 0);
    assert.throws(() => executionMode({ dryRun: false, autoApply: true, autoRent: true }, {}), /FLOP_CONFIRM_LIVE/);
  });

  test('席位没开时不签名也不下单', async () => {
    const dir = tempDir();
    const signer = path.join(dir, 'signer');
    const created = await createSignerFile(signer);
    const { fetchImpl, calls } = mockFetch(async () => ({ body: readFixture('limits-positions-full') }));
    const box = ctxOf(dir, fetchImpl, {
      cfg: { dryRun: false, autoApply: true, autoRent: true, signerFile: signer },
      env: { FLOP_CONFIRM_LIVE: '1' },
    });
    fs.writeFileSync(box.cfg.addressFile, `${created.address}\n`);
    const result = await box.run();
    assert.equal(result.waitReason, 'status');
    assert.equal(calls.some(c => c.method === 'POST'), false);
  });

  test('申请成功后才下单，订单号来自 my_orders 对账', async () => {
    const dir = tempDir();
    const signer = path.join(dir, 'signer');
    const created = await createSignerFile(signer);
    fs.writeFileSync(path.join(dir, 'miner.address'), `${created.address}\n`);
    const time = clock();
    const seen = [];
    const { fetchImpl, calls } = mockFetch(async (call) => {
      seen.push(`${call.method} ${call.url}`);
      if (call.url.includes('/limits')) return { body: readFixture('limits-open') };
      if (call.url.includes('/sponsor/')) {
        assert.equal(call.body.address, created.address);
        assert.match(call.body.issuedAt, /^\d+$/);
        assert.match(call.body.signature, /^0x[0-9a-f]+$/);
        return { status: 200, body: { ok: true } };
      }
      if (call.url.endsWith('/marketplace')) return { body: { code: 0, servers: [serverGood()] } };
      if (call.url.endsWith('/create_order')) {
        assert.equal(call.body.type, 'on-demand');
        assert.equal(call.body.rental_hours, 4);
        assert.equal(call.body.order_id, undefined);
        return { body: { code: 0 } };
      }
      if (call.url.endsWith('/my_orders')) {
        return { body: { code: 0, orders: [{ id: 38, si: 6, ct: Math.floor(time.now() / 1000), expired: false, pub_cluster: ['n1.example'], tcp_ports: ['22:10000'] }] } };
      }
      throw new Error(call.url);
    });
    const started = [];
    const box = ctxOf(dir, fetchImpl, {
      clock: time,
      cfg: {
        dryRun: false, autoApply: true, autoRent: true, signerFile: signer,
        backend: { plan() { return []; }, async start(info) { started.push(info); return { ok: true, ready: false }; } },
      },
      env: { FLOP_CONFIRM_LIVE: '1' },
    });
    const result = await box.run();
    assert.equal(result.phase, 'CALIBRATE');
    assert.equal(result.state.rent.orderId, 38);
    assert.equal(result.state.rent.ssh.port, 10000);
    assert.equal(started.length, 1);
    assert.equal('signer' in started[0], false);
    assert.equal(calls.filter(c => c.url.endsWith('/create_order')).length, 1);
    const phrase = fs.readFileSync(signer, 'utf8').trim().split(/\s+/)[0];
    assert.equal(JSON.stringify(result.logs).includes(phrase), false);
    assert.equal(JSON.stringify(result.state).includes(phrase), false);
    assert.equal(/0x[0-9a-f]{128,}/i.test(JSON.stringify(result.logs)), false);
    assert.equal(result.pearl.action, 'noop');
    assert.match(result.pearl.todo, /不实现/);
  });

  test('409 视为已赞助并继续，403 停止且不租', async () => {
    for (const [status, phase] of [[409, 'CALIBRATE'], [403, 'FAILED']]) {
      const dir = tempDir();
      const signer = path.join(dir, 'signer');
      const created = await createSignerFile(signer);
      fs.writeFileSync(path.join(dir, 'miner.address'), `${created.address}\n`);
      const time = clock();
      const { fetchImpl, calls } = mockFetch(async (call) => {
        if (call.url.includes('/limits')) return { body: readFixture('limits-open') };
        if (call.url.includes('/sponsor/')) return { status, body: { reason: status === 403 ? 'role' : 'already' } };
        if (call.url.endsWith('/marketplace')) return { body: { code: 0, servers: [serverGood()] } };
        if (call.url.endsWith('/create_order')) return { body: { code: 0 } };
        if (call.url.endsWith('/my_orders')) {
          return { body: { code: 0, orders: [{ id: 7, si: 6, ct: Math.floor(time.now() / 1000), expired: false, pub_cluster: ['n1.example'], tcp_ports: ['22:12000'] }] } };
        }
        throw new Error(call.url);
      });
      const box = ctxOf(dir, fetchImpl, {
        clock: time,
        cfg: {
          dryRun: false, autoApply: true, autoRent: true, signerFile: signer,
          backend: { plan() { return []; }, async start() { return { ok: true, ready: false }; } },
        },
        env: { FLOP_CONFIRM_LIVE: '1' },
      });
      const result = await box.run();
      assert.equal(result.phase, phase);
      assert.equal(calls.some(c => c.url.endsWith('/create_order')), status === 409);
    }
  });

  test('429 按 retryAfterSeconds 等待并用同一地址重试', async () => {
    const dir = tempDir();
    const signer = path.join(dir, 'signer');
    const created = await createSignerFile(signer);
    fs.writeFileSync(path.join(dir, 'miner.address'), `${created.address}\n`);
    const time = clock();
    let posts = 0;
    const { fetchImpl } = mockFetch(async (call) => {
      if (call.url.includes('/limits')) return { body: readFixture('limits-open') };
      if (call.url.includes('/sponsor/')) {
        posts += 1;
        assert.equal(call.body.address, created.address);
        if (posts === 1) return { status: 429, body: { retryAfterSeconds: 12, reason: 'daily_new_sponsorships', action: 'retry_later' } };
        return { status: 200, body: {} };
      }
      if (call.url.endsWith('/marketplace')) return { body: { code: 0, servers: [] } };
      if (call.url.endsWith('/my_orders')) return { body: { code: 0, orders: [] } };
      throw new Error(call.url);
    });
    const box = ctxOf(dir, fetchImpl, {
      clock: time,
      cfg: { dryRun: false, autoApply: true, autoRent: true, signerFile: signer, maxSponsorRetries: 2 },
      env: { FLOP_CONFIRM_LIVE: '1' },
    });
    const result = await box.run();
    assert.equal(posts, 2);
    assert.ok(time.now() - Date.UTC(2026, 10, 24, 12, 0, 0) >= 12_000);
    assert.equal(result.phase, 'SPONSORED');
    assert.equal(result.waitReason, 'no-server');
  });

  test('code 6 不算租到；超时对账完成前不第二次下单', async () => {
    const dir = tempDir();
    const signer = path.join(dir, 'signer');
    const created = await createSignerFile(signer);
    fs.writeFileSync(path.join(dir, 'miner.address'), `${created.address}\n`);
    const { fetchImpl, calls } = mockFetch(async (call) => {
      if (call.url.includes('/limits')) return { body: readFixture('limits-open') };
      if (call.url.includes('/sponsor/')) return { status: 200, body: {} };
      if (call.url.endsWith('/marketplace')) return { body: { code: 0, servers: [serverGood()] } };
      if (call.url.endsWith('/create_order')) return { body: { code: 6, error: 'amount_too_low' } };
      if (call.url.endsWith('/my_orders')) return { body: { code: 0, orders: [] } };
      throw new Error(call.url);
    });
    const box = ctxOf(dir, fetchImpl, {
      cfg: { dryRun: false, autoApply: true, autoRent: true, signerFile: signer },
      env: { FLOP_CONFIRM_LIVE: '1' },
    });
    const rejected = await box.run();
    assert.equal(rejected.phase, 'FAILED');
    assert.equal(rejected.state.failure.detail, 'amount_too_low');
    assert.equal(calls.filter(c => c.url.endsWith('/create_order')).length, 1);

    const dir2 = tempDir();
    const signer2 = path.join(dir2, 'signer');
    const created2 = await createSignerFile(signer2);
    fs.writeFileSync(path.join(dir2, 'miner.address'), `${created2.address}\n`);
    let creates = 0;
    const timed = mockFetch(async (call) => {
      if (call.url.includes('/limits')) return { body: readFixture('limits-open') };
      if (call.url.includes('/sponsor/')) return { status: 200, body: {} };
      if (call.url.endsWith('/marketplace')) return { body: { code: 0, servers: [serverGood()] } };
      if (call.url.endsWith('/create_order')) {
        creates += 1;
        throw Object.assign(new Error('请求超时'), { maybeSent: true });
      }
      if (call.url.endsWith('/my_orders')) return { body: { code: 0, orders: [] } };
      throw new Error(call.url);
    });
    const box2 = ctxOf(dir2, timed.fetchImpl, {
      cfg: { dryRun: false, autoApply: true, autoRent: true, signerFile: signer2 },
      env: { FLOP_CONFIRM_LIVE: '1' },
    });
    const unknown = await box2.run();
    assert.equal(unknown.phase, 'STOP_NEEDS_HUMAN');
    assert.equal(unknown.state.rent.createSubmitted, true);
    assert.equal(creates, 1);
    const again = await box2.run();
    assert.equal(again.phase, 'STOP_NEEDS_HUMAN');
    assert.equal(creates, 1);
  });

  test('重启后先对账未知订单，显存不够则失败且默认不退租', async () => {
    const dir = tempDir();
    const state = blankState();
    state.phase = 'RENT_UNKNOWN';
    state.seat = { ok: true, expiresAt: Date.now() + 60_000, graceHours: 4 };
    state.sponsor = { done: true };
    state.rent = { serverId: 6, intentAtSec: 1_700_000_000, unknownReason: 'timeout', createAttempts: 1, tag: 'flop-abc12345' };
    saveState(dir, state);
    const { fetchImpl, calls } = mockFetch(async (call) => {
      if (call.method === 'POST') throw new Error('对账前不应写');
      if (call.url.endsWith('/my_orders')) {
        return { body: { code: 0, orders: [{ id: 38, si: 6, ct: 1_700_000_010, expired: false, pub_cluster: ['n1.example'], tcp_ports: ['22:10000'] }] } };
      }
      throw new Error(call.url);
    });
    const box = ctxOf(dir, fetchImpl, {
      cfg: { dryRun: false, autoApply: true, autoRent: true, autoCancelOnFail: false },
      env: { FLOP_CONFIRM_LIVE: '1' },
      genesisVerified: true,
    });
    box.cfg.backend = { plan() { return []; }, async start() { return { ok: true, ready: false }; } };
    const badSsh = { exec: async (cmd) => (cmd.includes('nvidia') ? '4096 MiB' : '900GB') };
    const result = await runOnce({
      cfg: box.cfg,
      env: { FLOP_CONFIRM_LIVE: '1' },
      fetchImpl,
      now: () => 1_700_000_050_000,
      sleep: async () => {},
      stateDir: dir,
      genesis: DEVNET_GENESIS,
      genesisVerified: true,
      ssh: badSsh,
      sshKeys: async () => ({ publicKey: 'ssh-ed25519 AAAATEST flop' }),
    });
    assert.equal(result.phase, 'FAILED');
    assert.match(result.state.failure.reason, /显存/);
    assert.equal(calls.some(c => c.method === 'POST'), false);
    assert.equal(result.logs.join('\n').includes('不退租'), true);
  });

  test('DRY 遇到残留的租机状态只输出状态，写入口为零', async () => {
    const sshCalls = [];
    for (const phase of ['RENT_UNKNOWN', 'RENTED', 'BOOTSTRAP']) {
      const dir = tempDir();
      const state = blankState();
      state.phase = phase;
      state.sponsor = { done: true, sponsoredAt: Date.UTC(2026, 10, 24, 12, 0, 0) };
      state.rent = { orderId: 38, serverId: 6, createSubmitted: true, tag: 'flop-abc12345', ssh: { host: 'n1.example', port: 10000 } };
      saveState(dir, state);
      const { fetchImpl, calls } = mockFetch(async (call) => {
        if (call.method !== 'GET') throw new Error(`DRY 写了 ${call.method} ${call.url}`);
        return { body: readFixture('limits-open') };
      });
      const box = ctxOf(dir, fetchImpl, {
        env: { CLORE_API_KEY: 'test-key', FLOP_CONFIRM_LIVE: '1' },
        cfg: { dryRun: true, autoApply: true, autoRent: true, autoCancelOnFail: true },
      });
      const result = await runOnce({
        cfg: box.cfg,
        env: { CLORE_API_KEY: 'test-key' },
        fetchImpl,
        now: box.time.now,
        sleep: box.time.sleep,
        stateDir: dir,
        genesis: DEVNET_GENESIS,
        genesisVerified: true,
        ssh: { exec: async () => { sshCalls.push('ssh'); return '24576\n'; } },
        sshKeys: async () => { throw new Error('DRY 不应生成 SSH 密钥'); },
      });
      assert.equal(result.dry, true);
      assert.equal(result.readOnly, true);
      assert.equal(result.phase, phase);
      assert.equal(calls.filter(c => c.method !== 'GET').length, 0);
    }
    assert.equal(sshCalls.length, 0);
  });

  test('赞助成功后席位满了仍按 grace 租机', async () => {
    const dir = tempDir();
    const now0 = Date.UTC(2026, 10, 24, 12, 0, 0);
    const state = blankState();
    state.phase = 'SPONSORED';
    state.sponsor = { done: true, sponsoredAt: now0, address: ADDRESS, graceHours: 4 };
    saveState(dir, state);
    const time = clock(now0 + 1000);
    let creates = 0;
    const { fetchImpl } = mockFetch(async (call) => {
      if (call.url.includes('/limits')) return { body: readFixture('limits-positions-full') };
      if (call.url.endsWith('/my_orders')) return { body: { code: 0, orders: creates ? [{ id: 38, si: 6, ct: Math.floor(time.now() / 1000), expired: false, pub_cluster: ['n1.example'], tcp_ports: ['22:10000'] }] : [] } };
      if (call.url.endsWith('/marketplace')) return { body: { code: 0, servers: [serverGood()] } };
      if (call.url.endsWith('/create_order')) { creates += 1; return { body: { code: 0 } }; }
      throw new Error(call.url);
    });
    const box = ctxOf(dir, fetchImpl, {
      clock: time,
      cfg: { dryRun: false, autoApply: true, autoRent: true, backend: { plan() { return []; }, async start() { return { ok: true, ready: false }; } } },
      env: { FLOP_CONFIRM_LIVE: '1', CLORE_API_KEY: 'k' },
    });
    const result = await box.run();
    assert.equal(creates, 1);
    assert.equal(result.phase, 'CALIBRATE');
  });

  test('剩余时间不够开机加校准则 STOP_NEEDS_HUMAN，不下单', async () => {
    const dir = tempDir();
    const now0 = Date.UTC(2026, 10, 24, 12, 0, 0);
    const state = blankState();
    state.phase = 'SPONSORED';
    state.sponsor = { done: true, sponsoredAt: now0, graceHours: 4 };
    saveState(dir, state);
    let creates = 0;
    const { fetchImpl } = mockFetch(async (call) => {
      if (call.url.includes('/limits')) return { body: readFixture('limits-open') };
      if (call.url.endsWith('/create_order')) { creates += 1; return { body: { code: 0 } }; }
      return { body: { code: 0, orders: [], servers: [] } };
    });
    const box = ctxOf(dir, fetchImpl, {
      clock: clock(now0 + 3.6 * 3600 * 1000),
      cfg: { dryRun: false, autoApply: true, autoRent: true, bootEstimateMs: 3600 * 1000, calibrateEstimateMs: 3600 * 1000 },
      env: { FLOP_CONFIRM_LIVE: '1' },
    });
    const result = await box.run();
    assert.equal(result.phase, 'STOP_NEEDS_HUMAN');
    assert.equal(result.state.failure.reason, 'grace-too-short');
    assert.equal(creates, 0);
  });

  test('LIVE 没有 maxUsdPerHour 或 maxRentHours 就拒绝启动', async () => {
    const dir = tempDir();
    const { fetchImpl, calls } = mockFetch(async () => ({ body: readFixture('limits-open') }));
    const box = ctxOf(dir, fetchImpl, {
      cfg: { dryRun: false, autoApply: true, autoRent: true, maxUsdPerHour: null, maxRentHours: 4 },
      env: { FLOP_CONFIRM_LIVE: '1' },
    });
    await assert.rejects(() => box.run(), /maxUsdPerHour/);
    const box2 = ctxOf(tempDir(), fetchImpl, {
      cfg: { dryRun: false, autoApply: true, autoRent: true, maxUsdPerHour: 1, maxRentHours: null },
      env: { FLOP_CONFIRM_LIVE: '1' },
    });
    await assert.rejects(() => box2.run(), /maxRentHours/);
    assert.equal(calls.length, 0);
  });

  test('已有 flop 订单就接管，对账失败也不再下第二单', async () => {
    const dir = tempDir();
    const now0 = Date.UTC(2026, 10, 24, 12, 0, 0);
    const state = blankState();
    state.phase = 'SPONSORED';
    state.sponsor = { done: true, sponsoredAt: now0, graceHours: 4 };
    saveState(dir, state);
    let creates = 0;
    const { fetchImpl } = mockFetch(async (call) => {
      if (call.url.includes('/limits')) return { body: readFixture('limits-open') };
      if (call.url.endsWith('/my_orders')) {
        return { body: { code: 0, orders: [{ id: 38, si: 6, ct: Math.floor(now0 / 1000), expired: false, env: { FLOP_TAG: 'flop-existing1' }, pub_cluster: ['n1.example'], tcp_ports: ['22:10000'] }] } };
      }
      if (call.url.endsWith('/create_order')) { creates += 1; return { body: { code: 0 } }; }
      if (call.url.endsWith('/marketplace')) return { body: { code: 0, servers: [serverGood()] } };
      throw new Error(call.url);
    });
    const box = ctxOf(dir, fetchImpl, {
      clock: clock(now0 + 1000),
      cfg: { dryRun: false, autoApply: true, autoRent: true, backend: { plan() { return []; }, async start() { return { ok: true, ready: false }; } } },
      env: { FLOP_CONFIRM_LIVE: '1' },
    });
    const adopted = await box.run();
    assert.equal(creates, 0);
    assert.equal(adopted.state.rent.orderId, 38);
    assert.equal(adopted.phase, 'CALIBRATE');

    const dir2 = tempDir();
    const pending = blankState();
    pending.phase = 'RENT_UNKNOWN';
    pending.sponsor = { done: true, sponsoredAt: now0, graceHours: 4 };
    pending.rent = { createSubmitted: true, serverId: 6, intentAtSec: Math.floor(now0 / 1000), tag: 'flop-once' };
    saveState(dir2, pending);
    let creates2 = 0;
    let polls = 0;
    const timed = mockFetch(async (call) => {
      if (call.url.endsWith('/my_orders')) { polls += 1; return { body: { code: 0, orders: [] } }; }
      if (call.url.endsWith('/create_order')) { creates2 += 1; return { body: { code: 0 } }; }
      if (call.url.includes('/limits')) return { body: readFixture('limits-open') };
      throw new Error(call.url);
    });
    const box2 = ctxOf(dir2, timed.fetchImpl, {
      clock: clock(now0 + 1000),
      cfg: { dryRun: false, autoApply: true, autoRent: true, reconcileBudgetMs: 10_000 },
      env: { FLOP_CONFIRM_LIVE: '1' },
    });
    const missed = await box2.run();
    assert.equal(creates2, 0);
    assert.ok(polls >= 2);
    assert.equal(missed.phase, 'STOP_NEEDS_HUMAN');
    assert.equal(missed.state.failure.reason, 'reconcile-not-found');
  });

  test('review 没有提交地址就停止', async () => {
    const dir = tempDir();
    const box = ctxOf(dir, mockFetch(async () => ({ body: {} })).fetchImpl, { cfg: { sponsorMode: 'review', review: { submitUrl: '' } } });
    await assert.rejects(() => box.run(), /不会猜测 URL/);
  });
});
