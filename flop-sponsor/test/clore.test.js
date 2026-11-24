import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCreate, matchNewOrder, parseSshEndpoint, confirmCancel, createClore, planOrder } from '../src/clore.js';
import { assessHardware, filterServers } from '../src/gpu.js';
import { canTransition } from '../src/state.js';
import { clock, mockFetch, serverGood, orderGood } from './helpers.js';

test('create_order 只认 code，HTTP 200 且 code 6 是拒绝', () => {
  assert.equal(classifyCreate({ status: 200, data: { code: 0 } }).kind, 'accepted');
  const rejected = classifyCreate({ status: 200, data: { code: 6, error: 'amount_too_low' } });
  assert.equal(rejected.kind, 'rejected');
  assert.equal(rejected.error, 'amount_too_low');
  assert.equal(classifyCreate({ status: 200, data: {} }).kind, 'unknown');
});

test('对账按 si 和 ct ±120 秒，不读取响应里不存在的订单号', () => {
  const intent = 1_700_000_000;
  const hit = matchNewOrder([
    orderGood(intent + 30),
    orderGood(intent + 121),
    { ...orderGood(intent), si: 7, id: 99 },
  ], { serverId: 6, intentAtSec: intent });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].id, 38);
});

test('SSH 端口取高位映射，不用 22 本身也不用 80/443', () => {
  const ep = parseSshEndpoint({ pub_cluster: ['n1.example'], tcp_ports: ['22:10000'] });
  assert.deepEqual(ep, { host: 'n1.example', port: 10000, user: 'root' });
  assert.equal(parseSshEndpoint({ pub_cluster: ['n1.example'], tcp_ports: ['22:443'] }), null);
  assert.equal(parseSshEndpoint({ pub_cluster: ['n1.example'], tcp_ports: ['22:22'] }), null);
});

test('create_order 串行且至少间隔 5 秒', async () => {
  const time = clock(10_000);
  const { fetchImpl, calls } = mockFetch(async () => ({ body: { code: 0 } }));
  const clore = createClore({
    baseUrl: 'https://api.clore.ai/v1',
    apiKey: 'k',
    fetchImpl,
    now: time.now,
    sleep: time.sleep,
    lastCreateAt: 0,
  });
  await clore.createOrder({ renting_server: 1 });
  await clore.createOrder({ renting_server: 1 });
  assert.equal(calls.length, 2);
  assert.ok(time.now() - 10_000 >= 5_000);
});

test('取消返回 code 0 之后还要看活动列表', async () => {
  let orders = [{ id: 38, expired: false }];
  const { fetchImpl } = mockFetch(async (call) => {
    if (call.url.endsWith('/cancel_order')) return { body: { code: 0 } };
    return { body: { code: 0, orders } };
  });
  const clore = createClore({ baseUrl: 'https://api.clore.ai/v1', apiKey: 'k', fetchImpl, now: () => 0, sleep: async () => {} });
  const pending = await confirmCancel(clore, 38);
  assert.equal(pending.done, false);
  orders = [];
  const gone = await confirmCancel(clore, 38);
  assert.equal(gone.done, true);
});

test('on-demand 正文不带 spot，DRY 不放入真实公钥', () => {
  const body = planOrder({
    serverId: 6, image: 'example/image', currency: 'CLORE-Blockchain', tag: 'flop-abc12345',
    rentalHours: 6, autoRenew: false, publicKey: '',
  });
  assert.equal(body.type, 'on-demand');
  assert.equal(body.auto_renew, false);
  assert.equal(body.rental_hours, 6);
  assert.equal(body.ssh_key.includes('live'), true);
  assert.equal(body.ports['22'], 'tcp');
});

test('8B 至少 16GB，27B 要 80GB 显存和 200GB 盘', () => {
  const servers = [
    serverGood(),
    { ...serverGood(), id: 7, specs: { gpuram: 8, disk: 'NVMe disk 900GB' } },
    { ...serverGood(), id: 8, specs: { gpuram: 80, disk: 'NVMe disk 100GB' } },
    { ...serverGood(), id: 9, specs: { gpuram: 80, disk: 'NVMe disk 250GB' } },
  ];
  assert.deepEqual(filterServers(servers, { minVramGb: 16 }, 'CLORE-Blockchain').map(s => s.id), [6, 8, 9]);
  assert.deepEqual(filterServers(servers, { minVramGb: 80, minDiskGb: 200 }, 'CLORE-Blockchain').map(s => s.id), [9]);
  assert.equal(assessHardware({ smiText: '8192 MiB', diskText: '10GB', profile: { minVramGb: 16 } }).ok, false);
  assert.equal(assessHardware({ smiText: '81920 MiB', diskText: '250GB', profile: { minVramGb: 80, minDiskGb: 200 } }).ok, true);
});

test('没有席位记录不能直接租', () => {
  assert.equal(canTransition('SEAT_CHECK', 'RENT_INTENT'), false);
  assert.equal(canTransition('SPONSORED', 'RENT_INTENT'), true);
  assert.equal(canTransition('RENT_UNKNOWN', 'RENTED'), true);
});
