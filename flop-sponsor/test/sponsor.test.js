import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretSponsor, submitSponsor, createRateLimiter } from '../src/sponsor.js';
import { signSponsor } from '../src/sign.js';
import { Invariant } from '../src/errors.js';

test('赞助状态码', () => {
  assert.equal(interpretSponsor(200, {}).action, 'ok');
  assert.equal(interpretSponsor(409, { reason: 'already' }).reason, 'already-sponsored');
  assert.equal(interpretSponsor(403, { reason: 'role' }).action, 'stop');
  assert.equal(interpretSponsor(503, {}).action, 'retry');
  const limited = interpretSponsor(429, { retryAfterSeconds: 15, reason: 'daily_new_sponsorships' });
  assert.equal(limited.waitMs, 15_000);
  assert.equal(limited.sameAddress, true);
  assert.equal(interpretSponsor(429, {}).action, 'stop');
  assert.equal(interpretSponsor(503, { reason: 'account_busy', retryAfterSeconds: 9 }).reason, 'account_busy');
});

describe('单飞与限速', { concurrency: 1 }, () => {
test('account_busy 在单飞锁里只再试一次，不换正文', async () => {
  const bodies = [];
  let n = 0;
  const post = async (body) => {
    bodies.push(body);
    n += 1;
    if (n === 1) return { status: 503, data: { reason: 'account_busy', retryAfterSeconds: 2 } };
    return { status: 200, data: {} };
  };
  let slept = 0;
  const result = await submitSponsor({
    post,
    body: { address: '5Dsame', issuedAt: '1', signature: '0xabc' },
    limiter: async () => {},
    sleep: async (ms) => { slept += ms; },
  });
  assert.equal(result.decision.action, 'ok');
  assert.equal(slept, 2_000);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].address, bodies[1].address);
  assert.equal(bodies[0].signature, bodies[1].signature);
});

test('并发提交不会重叠 POST', async () => {
  let inflight = 0;
  let max = 0;
  const post = async () => {
    inflight += 1;
    max = Math.max(max, inflight);
    await new Promise(r => setTimeout(r, 20));
    inflight -= 1;
    return { status: 200, data: {} };
  };
  const limiter = async () => {};
  await Promise.all([
    submitSponsor({ post, body: { address: 'a' }, limiter, sleep: async () => {} }),
    submitSponsor({ post, body: { address: 'a' }, limiter, sleep: async () => {} }),
  ]);
  assert.equal(max, 1);
});

test('公开路由每分钟最多 6 次', async () => {
  let t = 0;
  const limiter = createRateLimiter({
    now: () => t,
    sleep: async (ms) => { t += ms; },
  });
  for (let i = 0; i < 6; i++) await limiter();
  await limiter();
  assert.ok(t >= 60_000);
});

});

test('未校验 genesis 不能签名', async () => {
  await assert.rejects(
    () => signSponsor({ signerFile: 'missing', genesis: '0x' + '11'.repeat(32), issuedAt: '1', genesisVerified: false }),
    Invariant,
  );
});
