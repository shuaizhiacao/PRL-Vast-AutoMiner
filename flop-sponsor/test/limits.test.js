import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSeat } from '../src/limits.js';
import { loadConfig } from '../src/config.js';
import { nextUtcMidnight, pollDelayMs } from '../src/time.js';
import { readFixture } from './helpers.js';

const cfg = loadConfig();
const now = Date.UTC(2026, 10, 24, 22, 15, 0);

test('positions_full 继续等，不进入申请', () => {
  const seat = decideSeat(readFixture('limits-positions-full'), cfg, now);
  assert.equal(seat.action, 'wait');
  assert.equal(seat.reason, 'status');
  assert.equal(seat.status, 'positions_full');
});

test('open 且各项有余量则通过，graceHours 来自 JSON', () => {
  const seat = decideSeat(readFixture('limits-open'), cfg, now);
  assert.equal(seat.action, 'pass');
  assert.equal(seat.graceHours, 4);
  assert.equal(seat.snapshot.dailyNew.limit, 1000);
});

test('每日新赞助名额用完则等到下一个 UTC 午夜', () => {
  const seat = decideSeat(readFixture('limits-daily-full'), cfg, now);
  assert.equal(seat.action, 'wait');
  assert.equal(seat.reason, 'daily-new');
  assert.equal(seat.until, nextUtcMidnight(now));
  assert.equal(seat.until, Date.UTC(2026, 10, 25));
});

test('限额数字不写死，换一个很小的 limit 同样生效', () => {
  const raw = readFixture('limits-open');
  raw.sponsor.miner.dailyNewSponsorships = { used: 2, limit: 2 };
  assert.equal(decideSeat(raw, cfg, now).reason, 'daily-new');
  raw.sponsor.miner.dailyStakeBudget = { usedFlop: '9', limitFlop: '9' };
  raw.sponsor.miner.dailyNewSponsorships = { used: 0, limit: 5 };
  assert.equal(decideSeat(raw, cfg, now).reason, 'daily-stake');
});

test('容量用满、网络不符、未校准满、结构未知', () => {
  const raw = readFixture('limits-open');
  raw.sponsor.miner.capacity = { used: 4, max: 4 };
  assert.equal(decideSeat(raw, cfg, now).reason, 'capacity');
  const other = readFixture('limits-open');
  other.network = 'testnet';
  assert.equal(decideSeat(other, cfg, now).reason, 'network');
  assert.equal(decideSeat(readFixture('limits-uncalibrated-full'), cfg, now).reason, 'uncalibrated');
  const unknown = decideSeat(readFixture('limits-unknown'), cfg, now);
  assert.equal(unknown.action, 'stop');
  assert.equal(unknown.reason, 'unknown-structure');
});

test('automatic 关闭时默认等待；review 模式不因此等待', () => {
  const raw = readFixture('limits-automatic-closed');
  assert.equal(decideSeat(raw, cfg, now).reason, 'automatic-closed');
  assert.equal(decideSeat(raw, { ...cfg, sponsorMode: 'review' }, now).action, 'pass');
});

test('轮询间隔夹在 30 到 60 秒', () => {
  assert.equal(pollDelayMs(() => 0, {}), 30_000);
  assert.equal(pollDelayMs(() => 1, {}), 60_000);
  assert.equal(pollDelayMs(() => 0, { pollMinMs: 1, pollMaxMs: 2 }), 30_000);
});
