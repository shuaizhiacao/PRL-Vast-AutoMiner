// 决策逻辑测试（由 test/run.mjs 在临时目录里运行，不会碰你的 data 文件夹）
// 决策逻辑测试：伪造时间与样本，验证退租/止损/租用规则
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = process.argv[2];
const U = p => pathToFileURL(path.join(dir, p)).href; // Windows 路径也能 import
process.chdir(dir);
fs.rmSync('data', { recursive: true, force: true });
fs.mkdirSync('data');
fs.writeFileSync('data/config.json', JSON.stringify({
  vastApiKey: 'test-key', wallet: 'prl1puauvt7txunf9zeu2qyrzv0pa5uvwjlq9a369s5wjpyxexjcypqddex7ac4',
  autoRent: true, autoDestroy: true, targetProfitPct: 30, stopLossPct: 0, maxInstances: 3, maxHourlySpend: 0.5,
  stopLossMinutes: 30, bootTimeoutMinutes: 20, minBalanceReserve: 1,
  hashWarmupMinutes: 10, configVersion: 3,
}));
const { Engine } = await import(U('src/engine.js'));
const MIN = 60000;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const e = new Engine();
e.log = () => {};
await e.refreshMarket(); await e.refreshWildrig(); await e.refreshVast(); await e.scan(true);
ok(e.marketFresh && e.usdHsHr > 0, '行情就绪');
ok(e.offers.length > 0 && e.offers.every(o => o.th > 0), `扫描到 ${e.offers.length} 个可评估机器`);
ok(!e.offers.some(o => /A100/.test(o.gpuName)), '未知型号（A100）被排除');

// ---- 预算上限：maxHourlySpend=0.5，已有手动 5080 $0.266 → 只剩 $0.234
e.lastRentAt = 0;
await e.decide();
const rented1 = Object.values(e.st.managed)[0];
ok(rented1 && rented1.dph <= 0.234 + 1e-9, `第一次自动租用在剩余预算内（$${rented1?.dph}）`);
ok(!e.offers.find(o => o.id === rented1.offerId && !o.used), '已租的 offer 被标记，不会重复租');

// ---- 60 秒内不会连续租
const n1 = Object.keys(e.st.managed).length;
await e.decide();
ok(Object.keys(e.st.managed).length === n1, '60 秒内不连续下单');

// ---- 币价暴跌后：旧扫描结果不能再触发租用
globalThis.__price = 0.3;
await e.refreshMarket();
e.lastRentAt = 0;
await e.decide();
ok(Object.keys(e.st.managed).length === n1, '币价暴跌后按最新价重算，不再租用');
globalThis.__price = 1.85;
await e.refreshMarket();

// ---- 部署超时：托管实例 25 分钟无算力 → 退租并拉黑机器
await e.refreshVast();
const id1 = Object.keys(e.st.managed)[0];
e.st.managed[id1].rentedAt = Date.now() - 25 * MIN;
e.samples.set(Number(id1), [{ t: Date.now() - 60000, hs: 0 }]);
// 让矿池里看不到它
const realWorkers = e.workers; e.workers = new Map([...realWorkers].filter(([k]) => k !== 'v' + id1));
await e.decide();
ok(!e.st.managed[id1], '部署超时 25 分钟无算力 → 自动退租');
ok(!Object.values(e.st.blacklist).some(b => /部署超时/.test(b.reason || '')), '默认可中断、还没出过算力的部署超时会退租，但不拉黑主机');

// ---- 手动实例永远不会被自动退
await e.refreshVast();
e.samples.set(10000001, [{ t: Date.now() - 20 * MIN, hs: 0 }]);
await e.decide();
ok(e.rawInstances.some(i => i.id === 10000001), '手动租的 5080 不会被自动退租');

// ---- 止损：构造一台正在挖但亏损的托管机
const inst = { id: 777, label: 'prl-auto-RTX3090', gpu_name: 'RTX 3090', num_gpus: 1, dph_total: 0.2, actual_status: 'running', intended_status: 'running', start_date: Date.now() / 1000 - 3600, machine_id: 4242 };
const fakeList = () => { e.rawInstances = [...e.rawInstances.filter(i => i.id !== 777), inst]; };
fakeList();
e.st.managed['777'] = { rentedAt: Date.now() - 60 * MIN, gpuName: 'RTX 3090', numGpus: 1, machineId: 4242, expectedTh: 130 };
const mk = (minAgo, hs) => ({ t: Date.now() - minAgo * MIN, hs });
e.samples.set(777, [mk(14, 130e12), mk(9, 130e12), mk(4, 130e12), mk(0.5, 130e12)]);
e.workers.set('v777', { hs: 130e12, gpus: [{ name: 'RTX 3090', hs: 130e12 }] });
const origRefresh = e.refreshVast.bind(e); e.refreshVast = async () => {};
let x = e.instances().find(i => i.id === '777');
ok(x.roi < 0, `亏损机器收益率 ${x.roi.toFixed(1)}%`);
await e.autoDestroy(e.instances());
ok(e.st.managed['777']?.belowSince > 0, '跌破止损 → 开始计时，但不立即退租');
e.st.managed['777'].belowSince = Date.now() - 31 * MIN;
// 收益回升 → 计时取消
inst.dph_total = 0.1; fakeList();
await e.autoDestroy(e.instances());
ok(e.st.managed['777'] && !e.st.managed['777'].belowSince, '收益率回到止损线以上 → 止损计时取消');
inst.dph_total = 0.2; fakeList();
await e.autoDestroy(e.instances());
e.st.managed['777'].belowSince = Date.now() - 31 * MIN;
let destroyed = null;
e.vast.destroy = async id => { destroyed = id; return { success: true }; };
await e.autoDestroy(e.instances());
ok(destroyed === '777', '持续低于止损线 31 分钟 → 自动退租');

// ---- 刚出算力不满 10 分钟：即使亏损也不判止损
const inst2 = { ...inst, id: 778, machine_id: 4343 };
e.rawInstances.push(inst2);
e.st.managed['778'] = { rentedAt: Date.now() - 8 * MIN, gpuName: 'RTX 3090', numGpus: 1, machineId: 4343, expectedTh: 130 };
e.samples.set(778, [mk(3, 0), mk(2, 130e12), mk(1, 130e12)]);
e.workers.set('v778', { hs: 130e12, gpus: [] });
await e.autoDestroy(e.instances());
ok(!e.st.managed['778'].belowSince, '出算力不满 10 分钟不判断止损');
x = e.instances().find(i => i.id === '778');
ok(Math.abs(x.avgHs - 130e12) < 1, '均值不把部署阶段的 0 算进去');

// ---- 掉线：之前有算力、最近 10 分钟连续为 0
const inst3 = { ...inst, id: 779, machine_id: 4444, dph_total: 0.05 };
e.rawInstances.push(inst3);
e.st.managed['779'] = { rentedAt: Date.now() - 60 * MIN, gpuName: 'RTX 3090', numGpus: 1, machineId: 4444 };
e.samples.set(779, [mk(14, 130e12), ...Array.from({ length: 22 }, (_, k) => mk(10.5 - k * 0.5, 0))]);
e.workers.delete('v779');
destroyed = null;
await e.autoDestroy(e.instances());
ok(destroyed === '779', '矿工掉线超过 10 分钟 → 自动退租');

// ---- 设置校验
try { e.updateConfig({ stopLossPct: 40, targetProfitPct: 30 }); ok(false, '止损高于目标应被拒绝'); } catch { ok(true, '止损线 ≥ 目标收益率 被拒绝'); }
try { e.updateConfig({ wallet: 'prl1puauvt7txunf9zeu2qyrzv0pa5uvwjlq9a369s5wjpyxexjcypqddex7ac5' }); ok(false, '错误钱包应被拒绝'); } catch { ok(true, '抄错一位的钱包地址被拒绝'); }
try { e.updateConfig({ minerArgs: '--x; rm -rf /' }); ok(false, '注入应被拒绝'); } catch { ok(true, '矿工参数里的危险符号被拒绝'); }
const pc = e.publicConfig();
ok(!pc.vastApiKey.includes('test-key'), 'API Key 在面板里是打码的');

// ---- NOCK
const P = await import(U('src/pearl.js'));
const ratio = P.nockPerPrl([{ epoch_label: '2026-10-18 09:00:00 UTC .. 2026-10-18 10:00:00 UTC', amount: 0.07068133183781625, share: 0.000004501587452660985 }], [{ epoch_label: '2026-10-18 09:00-10:00', amount: 0.0295, share: 0.000005 }]);
ok(Math.abs(ratio - 0.3758) < 0.001, `NOCK/PRL 比例反推正确（${ratio.toFixed(4)}）`);
e.refreshVast = origRefresh;
await e.refreshMarket();
ok(e.nockBonus === 0, '矿池未登记 NOCK 地址 → NOCK 不计入利润');
globalThis.__nockAddr = 'ArK1pS8pZcG8u8p3Yh6v7Q9nLmWx2Tt4Rr5Ee6Dd7Cc8Bb9Aa1Zz2Yy3Xx4Ww5Vv';
await e.refreshMarket();
const base = e.usdHsHrPrl;
ok(e.nockBonus > 0.003 && e.nockBonus < 0.005, `已登记 → NOCK 加成 ${(e.nockBonus * 100).toFixed(2)}%`);
ok(Math.abs(e.usdHsHr - base * (1 + e.nockBonus)) < 1e-25, '总收益 = PRL × (1 + NOCK 加成)');
e.updateConfig({ includeNock: false });
ok(e.nockBonus === 0, '关闭「计入 NOCK」开关后不计入');
e.updateConfig({ includeNock: true, nockAddress: globalThis.__nockAddr, maxHourlySpend: 2, maxInstances: 20 });
let captured = null;
e.vast.rent = async (id, b) => { captured = b; return { success: true, new_contract: 999 }; };
await e.scan(true);
e.lastRentAt = 0;
e.rawInstances = e.rawInstances.filter(i => !/\btok=/.test(String(i.label || '')) || (e.st.managed[String(i.id)] && e.st.managed[String(i.id)].dph > 0 && !e.st.managed[String(i.id)].restoredWithoutPrice));
e.st.pendingOrders = {};
await e.rent(e.offers.find(o => o.autoOk && o.rentable), 'manual');
ok(captured.onstart.includes('--user prl1puauvt7txunf9zeu2qyrzv0pa5uvwjlq9a369s5wjpyxexjcypqddex7ac4@nock=' + globalThis.__nockAddr), '新租机器的矿池用户名带 @nock=地址');
try { e.updateConfig({ nockAddress: 'abc0OIl' }); ok(false, '错误 NOCK 地址应被拒绝'); } catch { ok(true, '错误格式的 NOCK 地址被拒绝'); }
const snap = e.snapshot();
ok(snap.market.nockPerThDay > 0 && snap.account.nockPending === 0.0295, `面板数据含 NOCK（每 TH 日产 ${snap.market.nockPerThDay.toFixed(5)} NOCK）`);

// ---- 算力健康 & 重启
{
  const e2 = new Engine();
  e2.log = () => {};

  await e2.refreshMarket(); await e2.refreshVast();
  e2.setAlias("10000001", "5080");
  const now = Date.now();
  const fill = (id, hsFn, mins = 12) => e2.samples.set(Number(id), Array.from({ length: mins * 2 }, (_, k) => ({ t: now - (mins * 60 - k * 30) * 1000, hs: hsFn(k) })));
  // 5080：真实情况 96 TH/s（预期 195）
  fill(10000001, () => 96.4e12);
  e2.everHashed.add('10000001');
  e2.workers.set('5080', { hs: 96.4e12, gpus: [{ name: 'RTX 5080', hs: 96.4e12 }] });
  let x = e2.instances().find(i => i.id === '10000001');
  ok(x.health === 'low' && /49%/.test(x.healthMsg), `单卡掉到一半 → 判为「算力偏低」（${x.healthMsg}）`);
  // 正常机器
  e2.workers.set('5080', { hs: 200e12, gpus: [{ name: 'RTX 5080', hs: 200e12 }] });
  fill(10000001, () => 200e12);
  x = e2.instances().find(i => i.id === '10000001');
  ok(x.health === 'ok', `算力正常（${Math.round(x.hashRatio * 100)}%）→ 不报警`);
  // 2 卡机器，一张卡 45%
  e2.rawInstances.push({ id: 880, label: 'prl-auto-RTX4090', gpu_name: 'RTX 4090', num_gpus: 2, dph_total: 0.4, actual_status: 'running', start_date: now / 1000 - 3600, machine_id: 8800 });
  e2.st.managed['880'] = { rentedAt: now - 60 * MIN, gpuName: 'RTX 4090', numGpus: 2, machineId: 8800 };
  e2.workers.set('v880', { hs: 450e12, gpus: [{ name: 'RTX 4090', hs: 310e12 }, { name: 'RTX 4090', hs: 140e12 }] });
  fill(880, () => 450e12);
  x = e2.instances().find(i => i.id === '880');
  ok(x.health === 'gpu' && x.gpus.filter(g => !g.ok).length === 1, `多卡机器单卡偏弱 → 判为「显卡异常」（${x.healthMsg}）`);
  // 掉卡：2 卡只报了 1 张
  e2.workers.set('v880', { hs: 310e12, gpus: [{ name: 'RTX 4090', hs: 310e12 }] });
  x = e2.instances().find(i => i.id === '880');
  ok(x.health === 'gpu' && /1\/2/.test(x.healthMsg), `掉卡 → ${x.healthMsg}`);
  // 刚开始挖 2 分钟：不判
  e2.samples.set(880, [{ t: now - 2 * MIN, hs: 100e12 }, { t: now - MIN, hs: 100e12 }]);
  x = e2.instances().find(i => i.id === '880');
  ok(x.health === null, '刚出算力不满 3 分钟 → 不判断（算力爬升期）');
  // 坏机器不参与校准
  fill(880, () => 450e12);
  e2.workers.set('v880', { hs: 450e12, gpus: [{ name: 'RTX 4090', hs: 310e12 }, { name: 'RTX 4090', hs: 140e12 }] });
  e2.lastCalib.clear();
  e2.calibrate(e2.instances());
  ok(!e2.st.calib.RTX4090, '算力异常的机器不会拉低实测参考值');

  // 重启
  let rebootedId = null;
  e2.vast.reboot = async id => { rebootedId = id; return { success: true }; };
  await e2.reboot('880');
  ok(rebootedId === '880' && e2.st.restarts['880'] > 0, '一键重启调用了 vast 重启接口');
  e2.workers.delete('v880');
  e2.recordSamples();
  x = e2.instances().find(i => i.id === '880');
  ok(x.phase === 'restarting', '重启后、矿工上线前 → 状态为「重启中」');
  let destroyed2 = null;
  e2.vast.destroy = async id => { destroyed2 = id; return { success: true }; };
  e2.st.managed['880'].rentedAt = now - 120 * MIN;
  await e2.autoDestroy(e2.instances());
  ok(destroyed2 === null, '重启恢复期内不会被自动退租');
  try { await e2.reboot('880'); ok(false, '5 分钟内重复重启应被拒绝'); } catch { ok(true, '5 分钟内不能重复重启'); }
  // 恢复期过了还没算力 → 按部署超时退租
  e2.st.restarts['880'] = now - 25 * MIN;
  e2.samples.set(880, [...Array.from({ length: 10 }, (_, k) => ({ t: now - (40 - k) * MIN, hs: 450e12 })), ...Array.from({ length: 48 }, (_, k) => ({ t: now - (24 - k * 0.5) * MIN, hs: 0 }))]);
  x = e2.instances().find(i => i.id === '880');
  ok(x.avgHs === 0 && x.phase === 'nohash', '重启后的均值不混入重启前的算力');
  await e2.autoDestroy(e2.instances());
  ok(destroyed2 === '880', '重启后超过 20 分钟仍无算力 → 自动退租');
}

// ---- 被抢租 & 续航保护
{
  const e3 = new Engine();
  e3.log = () => {};
  e3.updateConfig({ maxInstances: 50, maxHourlySpend: 100, targetProfitPct: 20, minBalanceReserve: 2, minRunwayHours: 12, runwayGuard: true });
  await e3.refreshMarket(); await e3.refreshWildrig(); await e3.refreshVast(); await e3.scan(true);
  e3.account.vastBalance = 50; // 50-2=48 → 续航 12h 上限 $4/h
  e3.st.blacklist = {}; e3.st.managed = {}; e3.st.issuedOrders = {}; e3.st.orderHistory = []; e3.st.pendingOrders = {};
  const tried = [];
  let n = 0;
  e3.vast.rent = async id => {
    tried.push(id);
    if (n++ === 0) { const err = new Error('HTTP 400：error 404/3603: no_such_ask  Instance type by id ' + id + ' is not available.'); throw err; }
    return { success: true, new_contract: 7000 + n };
  };
  e3.lastRentAt = 0;
  await e3.decide();
  ok(tried.length >= 2 && tried.length <= 8, `第一台被抢走 → 同一轮立刻换下一台（试了 ${tried.length} 台）`);
  ok(tried.length - 1 >= 2 && tried.length - 1 <= 5, `一轮把达标的都租下（这轮租了 ${tried.length - 1} 台，上限 5）`);
  ok(Object.keys(e3.st.blacklist).length === 0, '被抢走的机器不拉黑');
  ok(!e3.offers.some(o => o.id === tried[0]), '被抢走的 offer 从列表里移除');
  ok(!!e3.st.managed['7002'], '第二台租用成功并纳入管理');

  // 续航：余额 8.32，保留 2 → 6.32/12 = $0.527/h
  const e4 = new Engine();
  const logs = [];
  e4.log = (l, m) => logs.push(m);
  e4.updateConfig({ maxInstances: 50, maxHourlySpend: 100, targetProfitPct: 20, minBalanceReserve: 2, minRunwayHours: 12, runwayGuard: true });
  await e4.refreshMarket(); await e4.refreshWildrig(); await e4.refreshVast(); await e4.scan(true);
  e4.account.vastBalance = 8.32;
  e4.st.blacklist = {}; e4.st.managed = {}; e4.st.issuedOrders = {}; e4.st.orderHistory = []; e4.st.pendingOrders = {};
  let rents = [];
  e4.vast.rent = async (id) => { rents.push(id); return { success: true, new_contract: 9000 + rents.length }; };
  const spend0 = e4.budget(e4.instances()).spend;
  const dphOf = Object.fromEntries(e4.offers.map(o => [o.id, o.dph]));
  for (let k = 0; k < 5; k++) { e4.lastRentAt = 0; await e4.decide(); e4.budget = ((orig) => (l) => { const b = orig.call(e4, l); const add = rents.reduce((a, id) => a + dphOf[id], 0); return { ...b, spend: b.spend + add, roomSpend: b.roomSpend - add, count: b.count + rents.length, roomCount: b.roomCount - rents.length }; })(Object.getPrototypeOf(e4).budget); }
  const total = spend0 + rents.reduce((a, id) => a + dphOf[id], 0);
  ok(total <= 6.32 / 12 + 1e-9, `余额 $8.32 时连续 5 轮总花费不超过续航上限 $0.527/h（已有 $${spend0.toFixed(3)} + 新租 ${rents.length} 台 = $${total.toFixed(3)}）`);
  e4.account.vastBalance = 2.5; // 0.5/12 = $0.04/h
  e4.lastRentAt = 0; const before = rents.length; await e4.decide();
  ok(rents.length === before && logs.some(m => /续航/.test(m)), '余额不够续航 12 小时 → 停止新租并提示');
}

// ---- 续航保护开关 / 部署计时 / 镜像源顺序
{
  const e5 = new Engine();
  e5.log = () => {};
  e5.updateConfig({ maxInstances: 50, maxHourlySpend: 100, targetProfitPct: 20, minBalanceReserve: 2, minRunwayHours: 12, runwayGuard: false });
  await e5.refreshMarket(); await e5.refreshWildrig(); await e5.refreshVast(); await e5.scan(true);
  e5.account.vastBalance = 2.5; // 开着保护时只能花 $0.04/h
  e5.st.blacklist = {};
  const rents = [];
  e5.vast.rent = async (id) => { rents.push(id); return { success: true, new_contract: 9500 + rents.length }; };
  e5.lastRentAt = 0; await e5.decide();
  const nOff = rents.length;
  ok(nOff >= 1 && e5.offers.filter(o => rents.includes(o.id)).reduce((a, o) => a + o.dph, 0) <= 0.5 + 1e-9, `关闭续航保护 → 余额少也照常租（${nOff} 台，合计不超过余额减保留金额 $0.5）`);
  ok(e5.snapshot().budget.spendCapByRunway === null, '关闭时面板拿到 null（不是 0）');
  e5.updateConfig({ runwayGuard: true });
  e5.lastRentAt = 0; await e5.decide();
  ok(rents.length === nOff, '重新打开续航保护 → 停止新租');

  // 部署计时：租下 → 容器 running → 出算力
  const id = String(9500 + 1);
  for (const k of Object.keys(e5.st.managed)) if (k !== id) delete e5.st.managed[k];
  const m = e5.st.managed[id];
  m.rentedAt = Date.now() - 7 * MIN;
  e5.rawInstances.push({ id: +id, label: 'prl-auto-x', gpu_name: 'RTX 3090', num_gpus: 1, dph_total: 0.1, actual_status: 'loading', start_date: Date.now() / 1000, machine_id: 1 });
  let x = e5.instances().find(i => i.id === id);
  ok(x.deploy && !x.deploy.runningAt, '拉镜像阶段：还没有 runningAt');
  e5.rawInstances.find(i => i.id === +id).actual_status = 'running';
  const realInst = e5.vast.instances; e5.vast.instances = async () => e5.rawInstances;
  await e5.refreshVast();
  ok(e5.st.managed[id].runningAt > 0, '容器开机 → 记录 runningAt');
  e5.st.managed[id].runningAt = Date.now() - 2 * MIN;
  e5.workers.set('v' + id, { hs: 130e12, gpus: [{ name: 'RTX 3090', hs: 130e12 }] });
  e5.workersOk = true;
  e5.recordSamples();
  const st = e5.st.deployStats.at(-1);
  ok(st && Math.round(st.total / 60) === 7 && Math.round(st.pull / 60) === 5 && Math.round(st.miner / 60) === 2, `出算力 → 记录部署用时（共 ${Math.round(st.total)}s，镜像 ${Math.round(st.pull)}s，矿工 ${Math.round(st.miner)}s）`);
  ok(e5.snapshot().deployAvg?.n >= 1, '面板拿到平均部署时间');
  e5.vast.instances = realInst;

  const O = await import(U('src/onstart.js'));
  const PL = [{ id: 'pearlhash', bin: 'wr', cmd: '--algo pearlhash --url stratum+ssl://p:1 --user w --worker $W' }];
  const cn = O.buildOnstart({ pools: PL, def: 'pearlhash', wildrigUrl: 'https://github.com/x.tar.xz', cnFirst: true });
  const us = O.buildOnstart({ pools: PL, def: 'pearlhash', wildrigUrl: 'https://github.com/x.tar.xz', cnFirst: false });
  ok(/URLS="https:\/\/ghfast/.test(cn) && /URLS="https:\/\/github/.test(us), '国内机器先走镜像源，海外机器先走 GitHub');
  // 租用时按地区选择
  let cap = null; e5.vast.rent = async (oid, b) => { cap = b; return { success: true, new_contract: 9600 }; };
  e5.lastRentAt = 0;
  await e5.scan(true);
  const freshCn = e5.offers.find(o => o.rentable && !Object.values(e5.st.managed).some(m => m.offerId === o.id));
  await e5.rent({ ...freshCn, geolocation: 'Guangdong, CN', used: false }, 'manual');
  ok(/wr\) F=wildrig-multi; URLS="https:\/\/ghfast/.test(cap.onstart), '「Guangdong, CN」被识别为国内机器');
}

// ---- vast 每日搜索额度（按条数计）
{
  const e6 = new Engine();
  e6.log = () => {};
  e6.updateConfig({ autoRent: true, maxInstances: 50, maxHourlySpend: 100, scanRows: 100, scanIntervalSec: 300 });
  e6.st.searchUsage = null; e6.st.quotaEst = null; e6.st.searchQuota = null; e6.st.scanPause = null;
  e6.scanPausedUntil = 0;
  await e6.refreshMarket(); await e6.refreshVast();
  await e6.scan(true);
  ok(globalThis.__lastLimit === 100, `每次只取 ${globalThis.__lastLimit} 条（原来是 1000）`);
  ok(e6.usageToday().requests === 1 && e6.usageToday().rows > 0, `今日用量被记录（${e6.usageToday().requests} 次 / ${e6.usageToday().rows} 条）`);

  // 额度用完
  globalThis.__quotaLeft = 0;
  globalThis.__quotaReset = Date.now() + 5 * 3600e3;
  const usedBefore = e6.usageToday().rows;
  await e6.scan(true).catch(() => {});
  ok(e6.pauseReason === 'quota' && Math.abs(e6.scanPausedUntil - globalThis.__quotaReset) < 2000, '额度用完 → 暂停到 vast 给的重置时间');
  ok(e6.st.quotaEst === usedBefore, `学到每日额度估计值（${e6.st.quotaEst} 条）`);
  let msg = '';
  try { await e6.scan(true); } catch (err) { msg = err.message; }
  ok(/额度已用完/.test(msg), '额度用完时点「立即扫描」→ 直接提示恢复时间，不再请求 vast');
  const e7 = new Engine(); e7.log = () => {};
  ok(e7.pauseReason === 'quota' && e7.scanPausedUntil > Date.now(), '重启程序后仍记得暂停，不会再撞一次上限');
  globalThis.__quotaLeft = null;

  // 普通的「请求太频繁」只等 2 分钟
  e6.scanPausedUntil = 0; e6.pauseReason = null;
  globalThis.__rateLimited = true;
  await e6.scan(true);
  ok(e6.pauseReason === 'rate' && e6.scanPausedUntil - Date.now() < 2.1 * MIN, '普通 429 只暂停 2 分钟');
  e6.scanPausedUntil = 0; e6.pauseReason = null;

  // 调度
  e6.st.quotaEst = 3000;
  e6.st.searchUsage = { day: e6.utcDay(), requests: 0, rows: 0 };
  let plan = e6.scanPlan();
  const expect = (e6.nextUtcMidnight() - Date.now()) / (Math.floor(2700 / 100) - 1);
  ok(Math.abs(plan.interval - Math.max(300e3, expect)) < 5000, `按每日额度 3000 条分摊：约每 ${Math.round(plan.interval / 60000)} 分钟扫一次`);
  e6.updateConfig({ autoRent: false });
  ok(e6.scanPlan().interval >= 15 * MIN, '自动租用关闭时 15 分钟扫一次');
  e6.updateConfig({ autoRent: true, maxInstances: 1 });
  ok(e6.scanPlan().skip === true, '已租满台数 → 跳过扫描，不浪费额度');
  e6.updateConfig({ maxInstances: 50 });
  globalThis.__sendQuotaHeaders = true; globalThis.__quotaLeft = 1500;
  const estBefore = e6.st.quotaEst;
  await e6.scan(true);
  ok(e6.st.quotaEst === estBefore && e6.st.rateLimitHeaders?.limit === 5000, 'X-RateLimit 响应头只记录，不再当成每日额度（今早把 30 当成每日额度导致停扫）');
  globalThis.__sendQuotaHeaders = false; globalThis.__quotaLeft = null;

  // 配置升级：旧默认值换新，自己改过的不动
  const fs2 = await import('node:fs');
  const cfgPath = dir + '/data/config.json';
  const saved = JSON.parse(fs2.readFileSync(cfgPath, 'utf8'));
  fs2.writeFileSync(cfgPath, JSON.stringify({ ...saved, minInetDown: 20, scanIntervalSec: 600, configVersion: undefined }));
  const S2 = await import(U('src/store.js') + '?v=' + Date.now());
  const c2 = S2.loadConfig();
  ok(c2.minInetDown === 200 && c2.scanIntervalSec === 600 && c2.configVersion === 3, '配置升级：带宽仍是旧默认 20 → 升到 200；扫描间隔用户改过（600）保持不变；版本记到 3');
}

// ---- 回归：今早 RTX 3080 Ti 租下 4 分钟就被判「掉线 10 分钟」误杀
{
  const e8 = new Engine();
  e8.log = () => {};
  await e8.refreshMarket(); await e8.refreshVast();
  const now = Date.now();
  e8.rawInstances.push({ id: 7777, label: 'prl-auto-RTX3080TI', gpu_name: 'RTX 3080 Ti', num_gpus: 1, dph_total: 0.135, actual_status: 'running', start_date: now / 1000 - 300, machine_id: 777 });
  e8.st.managed['7777'] = { rentedAt: now - 4.5 * MIN, gpuName: 'RTX 3080 Ti', numGpus: 1, machineId: 777 };
  // 矿工已经连上矿池但算力还是 0，每 15 秒采一次，采了 4 分钟（17 个样本）
  e8.workers.set('v7777', { hs: 0, gpus: [{ name: 'RTX 3080 Ti', hs: 0 }] });
  e8.samples.set(7777, Array.from({ length: 17 }, (_, k) => ({ t: now - (4 * 60 - k * 15) * 1000, hs: 0 })));
  let killed = null; e8.vast.destroy = async id => { killed = id; return { success: true }; };
  let x = e8.instances().find(i => i.id === '7777');
  ok(x.phase === 'booting', `矿工连上但还没出算力 → 算「部署中」而不是「无算力」（${x.phase}）`);
  await e8.autoDestroy(e8.instances());
  ok(killed === null, '租下 4 分钟、17 个零样本 → 不会被误判掉线退租');
  // 真掉线：之前出过算力，之后连续 11 分钟为 0
  e8.samples.set(7777, [{ t: now - 20 * MIN, hs: 120e12 }, { t: now - 11.5 * MIN, hs: 120e12 }, ...Array.from({ length: 44 }, (_, k) => ({ t: now - (11 * 60 - k * 15) * 1000, hs: 0 }))]);
  e8.everHashed.add('7777');
  x = e8.instances().find(i => i.id === '7777');
  await e8.autoDestroy(e8.instances());
  ok(killed === '7777', `真正掉线 11 分钟 → 退租（${x.phase}）`);
  // 掉线才 6 分钟（采样很密）→ 不退
  killed = null;
  e8.samples.set(7777, [{ t: now - 7 * MIN, hs: 120e12 }, ...Array.from({ length: 24 }, (_, k) => ({ t: now - (6 * 60 - k * 15) * 1000, hs: 0 }))]);
  await e8.autoDestroy(e8.instances());
  ok(killed === null, '掉线 6 分钟（24 个样本）→ 不退，按时间而不是样本数判断');
  // 断网告警数据
  e8.vastFailSince = now - 5 * MIN;
  ok(Math.round(e8.snapshot().netDown.vastMin) === 5, '面板拿到「连不上 vast 已 5 分钟」');
}

// ---- 回归：挖了 20 小时的 2080 Ti，vast 短暂报告离线就被按「部署超时」立刻退租
{
  const e10 = new Engine();
  const lg = []; e10.log = (lv, m) => lg.push(m);
  await e10.refreshMarket(); await e10.refreshVast();
  const now = Date.now();
  e10.rawInstances.push({ id: 5688, label: 'prl-auto-RTX2080TI', gpu_name: 'RTX 2080 Ti', num_gpus: 2, dph_total: 0.163, actual_status: 'offline', intended_status: 'running', status_msg: 'success, running vastai/base-image', start_date: now / 1000 - 20 * 3600, machine_id: 5688 });
  e10.st.managed['5688'] = { rentedAt: now - 20 * 60 * MIN, runningAt: now - 20 * 60 * MIN + 30000, hashAt: now - 20 * 60 * MIN + 90000, gpuName: 'RTX 2080 Ti', numGpus: 2, machineId: 5688 };
  let killed = null; e10.vast.destroy = async id => { killed = id; return { success: true }; };
  await e10.autoDestroy(e10.instances());
  ok(killed === null && e10.st.managed['5688'].offlineSince, '出过算力的机器刚报离线 → 不退租，开始计时');
  e10.rawInstances[e10.rawInstances.length - 1].actual_status = 'running';
  await e10.autoDestroy(e10.instances());
  ok(killed === null && !e10.st.managed['5688'].offlineSince, '恢复在线 → 清掉离线计时');
  e10.rawInstances[e10.rawInstances.length - 1].actual_status = 'offline';
  await e10.autoDestroy(e10.instances());
  e10.st.managed['5688'].offlineSince = now - 11 * MIN;
  await e10.autoDestroy(e10.instances());
  ok(killed === '5688' && lg.some(l => /离线超过 10 分钟/.test(l)) && !lg.some(l => /部署超时/.test(l)), '连续离线 11 分钟 → 退租，原因写「离线」而不是「部署超时」');
  // 程序重启后内存里的出算力记录丢了：有 hashAt 就不算部署中
  const e11 = new Engine(); e11.log = () => {};
  await e11.refreshMarket(); await e11.refreshVast();
  e11.rawInstances.push({ id: 5689, label: 'prl-auto-RTX2080TI', gpu_name: 'RTX 2080 Ti', num_gpus: 2, dph_total: 0.163, actual_status: 'running', intended_status: 'running', start_date: now / 1000 - 20 * 3600, machine_id: 5689 });
  e11.st.managed['5689'] = { rentedAt: now - 20 * 60 * MIN, hashAt: now - 20 * 60 * MIN + 90000, gpuName: 'RTX 2080 Ti', numGpus: 2, machineId: 5689 };
  let k2 = null; e11.vast.destroy = async id => { k2 = id; return { success: true }; };
  const x11 = e11.instances().find(i => i.id === '5689');
  await e11.autoDestroy(e11.instances());
  ok(x11.phase !== 'booting' && k2 === null, `程序重启后矿池暂时没数据 → 不会被当成部署中误杀（${x11.phase}）`);
}

// ---- 精准搜索 + 屏蔽反复租不到的机器
{
  const e12 = new Engine(); const lg = []; e12.log = (l, m) => lg.push(m);
  e12.updateConfig({ targetProfitPct: 20 });
  await e12.refreshMarket(); await e12.refreshVast();
  globalThis.__quotaLeft = null; e12.scanPausedUntil = 0; e12.st.vastNames = {}; e12.scanN = 0;
  await e12.scan(true);
  ok(!globalThis.__lastQuery.gpu_name && e12.offerStats.mode === '全量搜索' && Object.keys(e12.st.vastNames || {}).length > 0, `第一次全量搜索，学到 vast 的型号名（${Object.keys(e12.st.vastNames || {}).length} 个）`);
  await e12.scan(true);
  const q = globalThis.__lastQuery.gpu_name?.in || [];
  ok(q.length > 0 && q.every(n => e12.thFor(n)?.autoOk) && /精准搜索/.test(e12.offerStats.mode), `之后只搜能达标的已知型号（${e12.offerStats.mode}：${q.slice(0, 4).join('、')}…）`);
  for (let k = 0; k < 5; k++) await e12.scan(true);
  ok(!globalThis.__lastQuery.gpu_name, '每 6 次做一次全量搜索，发现新型号');
  const realSearch = e12.vast.searchOffers.bind(e12.vast);
  e12.scanN = 1; e12.vast.searchOffers = async (f, m, names) => { if (names) { const er = new Error('HTTP 400：bad gpu_name'); er.status = 400; throw er; } return realSearch(f, m); };
  await e12.scan(true);
  ok(e12.focusedOff && e12.offerStats.mode === '全量搜索' && e12.offers.length > 0 && lg.some(m => /改回全量搜索/.test(m)), 'vast 不接受精准搜索 → 当次自动改用全量，之后不再用');
  e12.vast.searchOffers = realSearch;
  const o = e12.offers[0];
  e12.st.goneCount = {}; e12.st.blacklist = {};
  for (const id of Object.keys(e12.st.managed)) if (!e12.rawInstances.some(i => String(i.id) === String(id))) delete e12.st.managed[id];
  e12.vast.rent = async id => { throw new Error('HTTP 400：no_such_ask Instance type by id ' + id + ' is not available.'); };
  try { await e12.rent({ ...o }, 'auto'); } catch {}
  ok(!e12.st.blacklist[o.machineId], '第一次租不到：当作被抢走，不屏蔽');
  try { await e12.rent({ ...o }, 'auto'); } catch {}
  ok(e12.st.blacklist[o.machineId]?.reason === '反复租不到' && lg.some(m => /反复出现在列表里却租不到/.test(m)), '同一台 2 小时内第 2 次租不到 → 屏蔽 2 小时');
}

// ---- 开机后矿工迟迟不上线：抓日志 + 提前退租
{
  const e9 = new Engine();
  e9.log = () => {};
  e9.updateConfig({ minerStartTimeoutMinutes: 8 });
  await e9.refreshMarket(); await e9.refreshVast();
  const now = Date.now();
  e9.rawInstances.push({ id: 8888, label: 'prl-auto-RTX3080', gpu_name: 'RTX 3080', num_gpus: 1, dph_total: 0.109, actual_status: 'running', start_date: now / 1000 - 700, machine_id: 888 });
  e9.st.managed['8888'] = { rentedAt: now - 6 * MIN, runningAt: now - 5 * MIN, gpuName: 'RTX 3080', numGpus: 1, machineId: 888 };
  let killed = null, reason = '';
  const realDestroy = e9.destroy.bind(e9);
  e9.vast.destroy = async id => { killed = id; return { success: true }; };
  e9.log = (l, msg) => { if (/已退租实例 8888/.test(msg)) reason = msg; };
  globalThis.__logReqs = 0;
  await e9.autoDestroy(e9.instances());
  ok(globalThis.__logReqs === 1 && killed === null, '开机 5 分钟还没上线 → 自动抓机器日志，但先不退租');
  const x = e9.instances().find(i => i.id === '8888');
  ok(/CUDA error 999/.test(x.logHint), `卡片上显示日志里的关键报错（${x.logHint}）`);
  await e9.autoDestroy(e9.instances());
  ok(globalThis.__logReqs === 1, '3 分钟内不重复抓日志');
  e9.st.managed['8888'].runningAt = now - 9 * MIN;
  await e9.autoDestroy(e9.instances());
  ok(killed === '8888' && /8 分钟矿工仍未上线：.*CUDA error 999/.test(reason), `开机 9 分钟仍未上线 → 提前退租，原因附带日志（${reason.slice(0, 80)}…）`);
  ok(Object.values(e9.st.blacklist).some(b => /矿工仍未上线/.test(b.reason)), '这台机器被拉黑 24 小时');
  // 只有进度没有报错时，摘要取最后一条 [prl] 进度
  globalThis.__logText = `[prl] 01:00:00 worker=v2
[prl] 01:00:00 download https://github.com/x
[prl] 01:02:00 download https://ghfast.top/https://github.com/x
`;
  e9.rigLogs.clear();
  await e9.fetchLogs('8888');
  ok(/ghfast/.test(e9.logHint('8888')), `没有报错时显示最后一步进度（${e9.logHint('8888')}）`);
  globalThis.__logText = undefined;
}

// ---- P0：经济学排序、出价上限、热扫描、利润底线、抢占、重复下单
{
  const Econ = await import(U('src/economics.js'));
  const cheap = { id: 'a', thPerDollar: 900, roi: 40, dph: 0.05 };
  const priceyFlops = { id: 'b', thPerDollar: 80, roi: 5, dph: 3 };
  const ranked = Econ.rankByHashPerDollar([priceyFlops, cheap]);
  ok(ranked[0].id === 'a' && ranked[1].id === 'b', '跨型号按算力/美元排序，不按 FLOPS');
  const probes = Econ.modelProbePlan({
    modelNames: Array.from({ length: 10 }, (_, i) => ({ key: 'G' + i, names: ['G' + i] })),
    scanRows: 20, maxProbes: 8, cursor: 0,
  });
  ok(probes.probes.length === 8 && probes.probes.every(p => p.limit === 2) && probes.nextCursor === 8, '一轮只取 8 个型号、每个型号 2 条最低价，条数预算约 20');
  const probes2 = Econ.modelProbePlan({
    modelNames: Array.from({ length: 10 }, (_, i) => ({ key: 'G' + i, names: ['G' + i] })),
    scanRows: 20, maxProbes: 8, cursor: probes.nextCursor,
  });
  ok(probes2.probes[0].key === 'G8' && probes2.probes.some(p => p.key === 'G9'), '下一轮从上一轮没排到的型号继续，不会永远只搜前几个');
  const bid = Econ.planBid({ minBid: 0.1, storageHr: 0.01, bandwidthHr: 0.001, revenueHr: 0.2, targetProfitPct: 30, upliftPct: 3, budgetHr: 1 });
  ok(bid.ok && Math.abs(bid.bid - 0.103) < 1e-9 && bid.bid <= bid.maxBid, `3% 上浮后出价 $${bid.bid}，不超过经济上限 $${bid.maxBid?.toFixed?.(4)}`);
  const capped = Econ.planBid({ minBid: 0.1, storageHr: 0.01, bandwidthHr: 0, revenueHr: 0.15, targetProfitPct: 30, upliftPct: 5, budgetHr: 0.12 });
  ok(capped.ok && capped.bid <= capped.cap + 1e-9 && capped.bid >= 0.1 && capped.roi + 1e-6 >= 30, `预算比上浮价更紧时，出价停在上限 $${capped.bid}（收益率 ${capped.roi?.toFixed?.(1)}%）`);
  const tooDear = Econ.planBid({ minBid: 0.2, storageHr: 0.01, bandwidthHr: 0, revenueHr: 0.15, targetProfitPct: 30, upliftPct: 3, budgetHr: 1 });
  ok(!tooDear.ok, '最低出价已经高于经济上限时拒绝，而不是加价硬租');
  const bad = Econ.quoteOffer({ min_bid: 'nope', storage_cost: 0.1 }, { disk: 10, targetProfitPct: 30, bidUpliftPct: 3, bandwidthGbPerHour: 0 }, { revenuePerHsHour: 1e-15, hashrateHs: 1e14, mode: 'interruptible' });
  ok(!bad.ok, 'min_bid 不是数字时失败关闭');
  const stale = Econ.quoteOffer({ min_bid: 0.05, storage_cost: 0.1 }, { disk: 10, targetProfitPct: 30, bidUpliftPct: 3, bandwidthGbPerHour: 0 }, { revenuePerHsHour: 0, hashrateHs: 1e14, mode: 'interruptible' });
  ok(!stale.ok, '收益价缺失或为 0 时失败关闭');
  const floorIn = { floorPct: 12, costKnown: true, costHr: 0.2, marketFresh: true, expectedRoi: 40, sustainedRoi: 8, sinceHashMin: 2, warmupMin: 4, belowForMin: 0, persistMin: 12, negForMin: 0, negExitMin: 5, samplesOk: true, wasBelow: false, unknownForMin: 0, unknownExitMin: 15 };
  const floorHold = Econ.profitFloorDecision(floorIn);
  ok(floorHold.action === 'warmup', '预热期内即使低于 12% 底线也不退出');
  const floorArm = Econ.profitFloorDecision({ ...floorIn, sinceHashMin: 6 });
  ok(floorArm.action === 'arm-floor', '预热结束后，8% 低于 12% 底线，开始计时而不是当成允许的亏损');
  const floorExit = Econ.profitFloorDecision({ ...floorIn, sinceHashMin: 6, belowForMin: 12, wasBelow: true });
  ok(floorExit.action === 'exit' && floorExit.path === 'floor', '低于底线持续 12 分钟后退出');
  const neg = Econ.profitFloorDecision({ ...floorIn, expectedRoi: -5, sustainedRoi: null, samplesOk: false, sinceHashMin: 1, negForMin: 5 });
  ok(neg.action === 'exit' && neg.path === 'negative', '保守满算力仍然亏钱时，预热没结束也会在短计时后退出');
  const drop = Econ.hotDecision({ fresh: true, usd: 1, prevUsd: 1.2, roomToRent: true, qualifyingFresh: 0, now: 10, coolUntil: 0, upPct: 3, badMarket: false });
  ok(!drop.arm && /下降/.test(drop.why), '收益下降不打开热扫描');
  const up = Econ.hotDecision({ fresh: true, usd: 1.2, prevUsd: 1, roomToRent: true, qualifyingFresh: 0, now: 10, coolUntil: 0, upPct: 3, badMarket: false });
  ok(up.arm, '收益上升且还有租用空间才打开热扫描');
  const full = Econ.hotDecision({ ...up, roomToRent: false, usd: 1.2, prevUsd: 1 });
  ok(!full.arm, '没有租用空间时不因涨价加速');
  const qual = Econ.hotDecision({ fresh: true, usd: 1, prevUsd: 1, roomToRent: true, qualifyingFresh: 2, now: 10, coolUntil: 0, upPct: 3 });
  ok(qual.arm && /达标/.test(qual.why), '新出现达标报价可以打开有限热窗口');
  const cool = Econ.hotDecision({ ...qual, coolUntil: 20, now: 10 });
  ok(!cool.arm, '冷却期内不能再次打开热扫描');
  const badMkt = Econ.hotDecision({ ...qual, fresh: false, qualifyingFresh: 3 });
  ok(!badMkt.arm, '行情不新鲜时不打开热扫描');
  const pace = Econ.resolveScanInterval({ baseMs: 600_000, fastMs: 45_000, hotActive: true, quotaPaceMs: 600_000 });
  ok(pace.why === 'quota-blocks-hot' && pace.interval === 600_000, '额度只够 10 分钟一次时，热扫描不能改成 45 秒');
  const fast = Econ.resolveScanInterval({ baseMs: 600_000, fastMs: 45_000, hotActive: true, quotaPaceMs: null });
  ok(fast.why === 'hot' && fast.interval === 45_000, '额度宽裕时热扫描用 45 秒，慢扫描基线仍是 600 秒');
}

{
  const eP = new Engine();
  eP.log = () => {};
  eP.updateConfig({ autoRent: false, targetProfitPct: 30, maxHourlySpend: 5, maxInstances: 5 });
  await eP.refreshMarket();
  eP.evaluateOffers([
    { id: 1, machine_id: 1, gpu_name: 'H100 SXM', num_gpus: 8, dph_total: 20, dph_base: 19, min_bid: 12, storage_cost: 0.1, inet_up_cost: 0, inet_down_cost: 0, search: { gpuCostPerHour: 19, diskHour: 0.02 }, reliability2: 0.99, flops_per_dphtotal: 99999, geolocation: 'Texas, US', inet_down: 1000, cuda_max_good: 12.8 },
    { id: 2, machine_id: 2, gpu_name: 'RTX 4070S', num_gpus: 1, dph_total: 0.2, dph_base: 0.19, min_bid: 0.05, storage_cost: 0.1, inet_up_cost: 0, inet_down_cost: 0, search: { gpuCostPerHour: 0.19, diskHour: 0.001 }, reliability2: 0.99, flops_per_dphtotal: 1, geolocation: 'Tokyo, JP', inet_down: 800, cuda_max_good: 12.6 },
    { id: 3, machine_id: 3, gpu_name: 'RTX 3060', num_gpus: 1, dph_total: 0.08, dph_base: 0.07, min_bid: 0.03, storage_cost: 0.1, inet_up_cost: 0, inet_down_cost: 0, search: { diskHour: 0.001 }, reliability2: 0.99, flops_per_dphtotal: 3, geolocation: 'Texas, US', inet_down: 500, cuda_max_good: 12.4 },
  ]);
  ok(eP.offers[0].gpuName.includes('4070') || eP.offers[0].thPerDollar >= eP.offers.find(o => /3060/.test(o.gpuName)).thPerDollar, `便宜的 4070S 按算力/美元排在前面（第一名 ${eP.offers[0].gpuName}）`);
  ok(eP.offers.some(o => /4070/.test(o.gpuName)) && eP.offers.some(o => /3060/.test(o.gpuName)), '低 FLOPS 的便宜型号没有被高 FLOPS 机器挤掉');
  const vast = await import(U('src/vast.js'));
  const body = vast.searchBody({ ...eP.cfg, rentMode: 'interruptible', minReliability: 0.95, maxGpusPerMachine: 8, maxHourlySpend: 2, minCuda: 12.4, minInetDown: 200, scanRows: 20, disk: 10 }, ['RTX 4070S'], { limit: 2 });
  ok(body.type === 'bid' && body.order[0][0] === 'min_bid' && body.order[0][1] === 'asc' && body.min_bid?.lte === 2 && !body.dph_total, '可中断搜索按 min_bid 从低到高封顶，不用按需 dph_total 把便宜出价滤掉');
  const ondemand = vast.searchBody({ ...eP.cfg, rentMode: 'ondemand' }, null, {});
  ok(ondemand.type === 'on-demand' && ondemand.limit === 20, '按需模式显式使用 type=on-demand，默认一页 20 条');

  // 抢占：不拉黑主机，销毁以免存储一直计费
  const now = Date.now();
  eP.rawInstances = [{ id: 4242, label: 'prl-auto-RTX4070S pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1, dph_total: 0.08, actual_status: 'exited', intended_status: 'stopped', status_msg: 'client bid too low', start_date: now / 1000 - 3600, machine_id: 77, storage_cost: 0.12 }];
  eP.st.managed['4242'] = { rentedAt: now - 60 * MIN, gpuName: 'RTX 4070S', numGpus: 1, machineId: 77, rentMode: 'interruptible', hashAt: now - 30 * MIN };
  eP.instancesOk = true;
  let why = '';
  eP.vast.destroy = async id => { why = id; return { success: true }; };
  eP.st.managed['4242'].pausedSince = now - 4 * MIN;
  await eP.autoDestroy(eP.instances());
  ok(why === '4242' && !eP.st.blacklist[77], '抢占后销毁实例，且不把主机拉黑');

  // 退租失败会保留记录，下次重试；已经不存在则当成退掉了
  eP.rawInstances = [{ id: 4343, label: 'prl-auto-RTX4070S pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1, dph_total: 0.2, actual_status: 'running', intended_status: 'running', start_date: now / 1000 - 7200, machine_id: 78 }];
  eP.st.managed['4343'] = { rentedAt: now - 120 * MIN, gpuName: 'RTX 4070S', numGpus: 1, machineId: 78, hashAt: now - 100 * MIN, belowSince: now - 30 * MIN };
  eP.samples.set(4343, [0, 1, 2, 3, 4, 5].map(k => ({ t: now - (6 - k) * MIN, hs: 20e12 })));
  eP.workers.set('v4343', { hs: 20e12, gpus: [{ name: 'RTX 4070S', hs: 20e12 }] });
  eP.everHashed.add('4343');
  eP.cfg.stopLossPct = 12; eP.cfg.stopLossMinutes = 12; eP.cfg.hashWarmupMinutes = 4;
  let calls = 0;
  eP.vast.destroy = async () => { calls++; const err = new Error('HTTP 500：暂时失败'); err.status = 500; throw err; };
  let threw = false;
  try { await eP.autoDestroy(eP.instances()); } catch { threw = true; }
  ok(!threw && eP.st.managed['4343'] && eP.st.managed['4343'].destroyFails === 1, '退租接口失败时保留实例并记下失败次数，不中断这一轮');
  eP.vast.destroy = async () => { const err = new Error('HTTP 404：no such instance'); err.status = 404; throw err; };
  await eP.autoDestroy(eP.instances());
  ok(!eP.st.managed['4343'], 'vast 说实例已经不存在时，本地按已退租清掉，避免反复重试');

  // 超时后不重复下单；如果实例其实已经出现，就认领而不再 PUT
  await eP.refreshWildrig();
  await eP.refreshVast();
  for (const id of Object.keys(eP.st.managed)) if (!eP.rawInstances.some(i => String(i.id) === String(id))) delete eP.st.managed[id];
  const offer = eP.offers.find(o => o.rentable && o.autoOk);
  eP.vast.searchOffers = async (_f, _meta, _names, extra) => {
    if (String(extra?.id) !== String(offer.id)) return [];
    return [{
      id: offer.id, gpu_name: offer.gpuName, num_gpus: offer.numGpus, machine_id: offer.machineId,
      min_bid: offer.minBid, dph_base: offer.minBid, dph_total: offer.dph, storage_cost: 0.1,
      inet_up_cost: 0, inet_down_cost: 0, search: { diskHour: offer.storageHr, gpuCostPerHour: offer.minBid },
      reliability2: 0.99, geolocation: offer.geolocation || 'Tokyo, JP', inet_down: 800, cuda_max_good: 12.6,
    }];
  };
  eP.offers.forEach(o => { o.used = false; });
  eP.lastRentAt = 0;
  let puts = 0;
  eP.vast.rent = async () => { puts++; const err = new Error('网络错误：超时(60s)'); err.status = 0; throw err; };
  let unknown = false;
  try { await eP.rent(offer, 'manual'); } catch (err) { unknown = !!err.unknown; }
  ok(unknown && puts === 1 && eP.st.pendingOrders[String(offer.id)]?.state === 'unknown', '下单超时记为结果未知，不拉黑主机');
  puts = 0;
  try { await eP.rent(offer, 'manual'); } catch { /* 锁定 */ }
  ok(puts === 0, '结果未知的 10 分钟内不会对同一报价再 PUT');
  const token = eP.st.pendingOrders[String(offer.id)].token;
  eP.rawInstances.push({ id: 5150, label: `prl-auto-x tok=${token} pool=pearlhash`, gpu_name: offer.gpuName, num_gpus: offer.numGpus, dph_total: offer.dph, actual_status: 'loading', intended_status: 'running', machine_id: offer.machineId, start_date: Date.now() / 1000 });
  await eP.reconcilePending();
  ok(eP.st.managed['5150'] && !eP.st.pendingOrders[String(offer.id)], '超时之后如果实例已经在列表里，就认领它，不再下第二单');
}

{
  const Econ = await import(U('src/economics.js') + '?cost=1');
  const runningMsg = { actual_status: 'running', intended_status: 'running', status_msg: 'interruptible' };
  ok(!Econ.isPreempted(runningMsg, { rentMode: 'interruptible' }), '正在运行且状态里有 interruptible → 不是抢占');
  ok(!Econ.isPreempted({ actual_status: 'loading', status_msg: 'type interruptible' }, { rentMode: 'interruptible' }), 'loading 中的可中断实例不是抢占');
  ok(Econ.isPreempted({ actual_status: 'exited', intended_status: 'stopped', status_msg: 'outbid' }, { rentMode: 'interruptible' }), 'outbid 且已退出 → 是抢占');
  ok(Econ.isPreempted({ actual_status: 'stopped', intended_status: 'stopped', status_msg: 'preempted' }, { rentMode: 'interruptible' }), 'preempted 且已停止 → 是抢占');
  ok(Econ.isPreempted({ actual_status: 'exited', status_msg: 'instance interrupted' }, { rentMode: 'interruptible' }), 'interrupted 且已退出 → 是抢占');
  ok(!Econ.isPreempted({ actual_status: 'stopped', intended_status: 'stopped', status_msg: 'interruptible' }, { rentMode: 'ondemand' }), '按需实例的状态文字里有 interruptible 不算抢占');

  const eC = new Engine();
  eC.log = () => {};
  eC.updateConfig({ autoRent: false, maxHourlySpend: 2, maxInstances: 5, stopLossPct: -100, negativeExitMinutes: 60 });
  await eC.refreshMarket();
  eC.st.managed = {};
  eC.st.pendingOrders = {};
  eC.reservations = new Map();
  const now = Date.now();
  const disk = eC.cfg.disk;
  const storage = 0.144 * disk / (30 * 24);
  const bandwidth = (0.02 + 0.03) * eC.cfg.bandwidthGbPerHour;
  const bid = 0.05;
  const allIn = bid + storage + bandwidth;
  eC.rawInstances = [{
    id: 6101, label: 'prl-auto-RTX4070S pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1,
    dph_total: 0.42, dph_base: 0.4, actual_status: 'running', intended_status: 'running', status_msg: 'interruptible',
    start_date: now / 1000 - 7200, machine_id: 91, storage_cost: 0.144, inet_up_cost: 0.02, inet_down_cost: 0.03,
  }];
  eC.st.managed['6101'] = {
    rentedAt: now - 80 * MIN, hashAt: now - 70 * MIN, gpuName: 'RTX 4070S', numGpus: 1, machineId: 91,
    rentMode: 'interruptible', bid, dph: 0.2, pausedSince: now - 10 * MIN,
  };
  eC.everHashed.add('6101');
  eC.samples.set(6101, [0, 1, 2, 3, 4, 5].map(k => ({ t: now - (6 - k) * MIN, hs: 130e12 })));
  eC.workers.set('v6101', { hs: 130e12, gpus: [{ name: 'RTX 4070S', hs: 130e12 }] });
  eC.workersOk = true;
  const live = eC.instances().find(i => i.id === '6101');
  const wrongRoi = (live.expectedHs * eC.usdHsHr - 0.42) / 0.42 * 100;
  ok(live.phase !== 'preempted' && live.costKnown && Math.abs(live.dph - allIn) < 1e-9 && Math.abs(live.dph - 0.42) > 0.2, `运行中的合计时租用出价+存储+流量 $${live.dph?.toFixed(4)}，不用按需 dph_total $0.42`);
  ok(Math.abs(live.expRoi - wrongRoi) > 1, '预期收益率按合计时租算，不按更高的按需价');
  const bCost = eC.budget(eC.instances());
  ok(Math.abs(bCost.spend - allIn) < 1e-9 && bCost.roomSpend > 0, `预算花费用合计时租 $${bCost.spend.toFixed(4)}，不是按需价`);
  let killed = null;
  eC.vast.destroy = async id => { killed = id; return { success: true }; };
  await eC.autoDestroy(eC.instances());
  ok(killed == null && !eC.st.blacklist[91] && eC.st.managed['6101'], '运行中且状态含 interruptible → 不销毁、不拉黑');

  eC.rawInstances = [{
    id: 6102, label: 'prl-auto-RTX4070S pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1,
    dph_total: 0.55, actual_status: 'exited', intended_status: 'stopped', status_msg: 'preempted',
    start_date: now / 1000 - 3600, machine_id: 92,
  }];
  eC.st.managed = { '6102': { rentedAt: now - 60 * MIN, gpuName: 'RTX 4070S', numGpus: 1, machineId: 92, rentMode: 'interruptible', bid: 0.04, dph: 0.05, hashAt: now - 40 * MIN, pausedSince: now - 5 * MIN } };
  killed = null;
  await eC.autoDestroy(eC.instances());
  ok(killed === '6102' && !eC.st.blacklist[92], '已抢占的可中断实例会销毁，且不拉黑主机');

  eC.rawInstances = [{
    id: 6103, label: 'prl-auto-RTX4070S pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1,
    dph_total: 0.8, actual_status: 'running', intended_status: 'running', status_msg: 'interruptible',
    start_date: now / 1000 - 3600, machine_id: 93,
  }];
  eC.st.managed = { '6103': { rentedAt: now - 30 * MIN, gpuName: 'RTX 4070S', numGpus: 1, machineId: 93, rentMode: 'interruptible', bid: Number.NaN, dph: 'nope', hashAt: now - 20 * MIN } };
  const missing = eC.instances().find(i => i.id === '6103');
  const bMissing = eC.budget(eC.instances());
  ok(missing.dph == null && missing.dph !== 0 && missing.costKnown === false && missing.roi == null, '可中断实例费用缺失时不是 0，也不改用 dph_total');
  ok(bMissing.spend !== 0.8 && bMissing.costUnknown === true && bMissing.roomSpend === 0, '费用未知时预算不把它当成免费');
}

{
  const eQ = new Engine();
  eQ.log = () => {};
  eQ.updateConfig({ autoRent: false, maxHourlySpend: 0.5, maxInstances: 3, targetProfitPct: 30 });
  await eQ.refreshMarket(); await eQ.refreshWildrig(); await eQ.refreshVast();
  eQ.scanPausedUntil = 0; eQ.pauseReason = null; eQ.st.scanPause = null;
  const vast = await import(U('src/vast.js'));
  const seen = [];
  eQ.vast.searchOffers = async (f, meta, names, extra) => {
    const q = vast.searchBody(f, names, extra || {});
    seen.push(q);
    if (q.id) return [];
    if (q.type !== 'bid') return [];
    return [{
      id: 88001, machine_id: 88001, gpu_name: 'RTX 4070S', num_gpus: 1, dph_total: 4.2, min_bid: 0.04,
      storage_cost: 0.1, inet_up_cost: 0, inet_down_cost: 0, search: { diskHour: 0.001 },
      reliability2: 0.99, geolocation: 'Texas, US', inet_down: 800, cuda_max_good: 12.6,
    }];
  };
  await eQ.scan(true);
  ok(seen.some(q => q.type === 'bid' && q.min_bid && !q.dph_total) && eQ.offers.some(o => o.id === 88001 && o.dph < 0.2), '按需总价 $4.2、出价 $0.04 的机器仍出现在可中断搜索里');
  const noBw = (await import(U('src/economics.js'))).quoteOffer(
    { min_bid: 0.05, storage_cost: 0.1 },
    { disk: 10, targetProfitPct: 30, bidUpliftPct: 3, bandwidthGbPerHour: 0.05, rentMode: 'interruptible' },
    { revenuePerHsHour: 1e-12, hashrateHs: 1e14, mode: 'interruptible' },
  );
  const zeroBw = (await import(U('src/economics.js'))).quoteOffer(
    { min_bid: 0.05, storage_cost: 0.1, inet_up_cost: 0, inet_down_cost: 0 },
    { disk: 10, targetProfitPct: 30, bidUpliftPct: 3, bandwidthGbPerHour: 0.05, rentMode: 'interruptible' },
    { revenuePerHsHour: 1e-12, hashrateHs: 1e14, mode: 'interruptible' },
  );
  ok(!noBw.ok && /带宽/.test(noBw.why || ''), '带宽单价缺失不是 0，报价失败、不能下单');
  ok(zeroBw.ok && zeroBw.bandwidthHr === 0, '带宽单价明确为 0 时按免费计入');

  const now = Date.now();
  eQ.rawInstances = [{
    id: 6201, label: 'prl-auto-RTX4070S pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1,
    dph_total: 1.5, actual_status: 'running', intended_status: 'running', start_date: now / 1000 - 7200, machine_id: 201,
  }];
  eQ.st.managed = { '6201': { rentedAt: now - 60 * MIN, hashAt: now - 50 * MIN, gpuName: 'RTX 4070S', numGpus: 1, machineId: 201, rentMode: 'interruptible', dph: 'nope', bid: null } };
  eQ.everHashed.add('6201');
  eQ.samples.set(6201, [0, 1, 2, 3, 4].map(k => ({ t: now - (5 - k) * MIN, hs: 10e12 })));
  eQ.workersOk = true;
  eQ.st.managed['6201'].belowSince = now - 40 * MIN;
  const snap = eQ.summary();
  ok(snap.costState === 'unknown' && snap.spendHr == null && snap.roi == null && snap.profitHr == null, '有未知费用时汇总不把成本当 0，收益率也不给乐观数字');
  let killed = null;
  eQ.vast.destroy = async id => { killed = id; return { success: true }; };
  await eQ.autoDestroy(eQ.instances());
  ok(killed == null && eQ.st.managed['6201'], '费用未知时不按亏损销毁');

  eQ.rawInstances = [{
    id: 6202, label: 'prl-auto-RTX4070S pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1,
    dph_total: 0.2, actual_status: 'offline', intended_status: 'running', status_msg: 'offline',
    start_date: now / 1000 - 7200, machine_id: 202,
  }];
  eQ.st.managed = { '6202': { rentedAt: now - 80 * MIN, hashAt: now - 70 * MIN, gpuName: 'RTX 4070S', numGpus: 1, machineId: 202, rentMode: 'interruptible', bid: 0.05, dph: 0.06, offlineSince: now - 11 * MIN } };
  eQ.everHashed.add('6202');
  killed = null;
  await eQ.autoDestroy(eQ.instances());
  ok(killed === '6202' && !eQ.st.blacklist[202], '可中断实例被报离线会销毁，但不拉黑主机');

  eQ.rawInstances = [];
  eQ.st.managed = {};
  const offer = { id: 88002, machineId: 303, gpuName: 'RTX 4070S', numGpus: 1, dph: 0.4, th: 122, geolocation: 'Texas, US', autoOk: true, rentable: true, roi: 40, inetDown: 500 };
  eQ.offers = [offer];
  eQ.cfg.maxHourlySpend = 0.2;
  eQ.account.vastBalance = 20;
  eQ.market.updatedAt = Date.now();
  let puts = 0;
  const cheapRaw = id => ({ id, machine_id: 303, gpu_name: 'RTX 4070S', num_gpus: 1, dph_total: 0.4, min_bid: 0.35, storage_cost: 0.1, inet_up_cost: 0, inet_down_cost: 0, search: { diskHour: 0.001 }, reliability2: 0.99, geolocation: 'Texas, US', inet_down: 800, cuda_max_good: 12.6 });
  eQ.vast.searchOffers = async (_f, _m, _n, extra) => [cheapRaw(extra?.id || 88002)];
  eQ.vast.rent = async () => { puts++; return { success: true, new_contract: 8801 }; };
  let manualErr = '';
  try { await eQ.rent(offer, 'manual'); } catch (err) { manualErr = err.message; }
  ok(puts === 0 && /预算|上限/.test(manualErr), '手动租用也不能超出剩余每小时预算');

  eQ.cfg.maxHourlySpend = 5;
  offer.dph = 0.05;
  eQ.vast.searchOffers = async (_f, _m, _n, extra) => [{ ...cheapRaw(extra?.id || 88003), min_bid: 0.04, machine_id: 304 }];
  let gate; const wait = new Promise(r => { gate = r; });
  let started = 0;
  eQ.vast.rent = async () => { started++; await wait; return { success: true, new_contract: 8900 + started }; };
  const a = eQ.rent({ ...offer, id: 88003, machineId: 304, dph: 0.05 }, 'manual');
  const b = eQ.rent({ ...offer, id: 88003, machineId: 304, dph: 0.05 }, 'manual');
  gate();
  const both = await Promise.allSettled([a, b]);
  ok(started === 1 && both.filter(x => x.status === 'fulfilled').length === 1, '同一报价重复点击只提交一次');

  eQ.instancesOk = true;
  eQ.rawInstances = [];
  eQ.st.pendingOrders = { '88004': { at: now - 20 * MIN, state: 'unknown', token: 'late01', offerId: 88004, machineId: 404, dph: 0.05, gpuName: 'RTX 4070S', numGpus: 1, rentMode: 'interruptible', bid: 0.04, pool: 'pearlhash', pools: ['pearlhash'], mode: 'args', listMisses: 0 } };
  let searches = 0;
  const realSearch = eQ.vast.searchOffers;
  eQ.vast.searchOffers = async (...args) => { searches++; return realSearch(...args); };
  eQ.vast.rent = async () => { puts++; return { success: true, new_contract: 8910 }; };
  puts = 0;
  await eQ.reconcilePending();
  try { await eQ.rent({ id: 88004, machineId: 404, gpuName: 'RTX 4070S', numGpus: 1, dph: 0.05, th: 122, geolocation: 'Texas, US' }, 'manual'); } catch {}
  ok(puts === 0 && searches === 0 && eQ.st.pendingOrders['88004'], '超过 10 分钟仍未确认时不重新下单，也不为对账去搜市场');
  eQ.rawInstances = [{ id: 8911, label: 'prl-auto-RTX4070S tok=late01 pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1, machine_id: 404, actual_status: 'running', dph_total: 2, start_date: now / 1000 - 600 }];
  await eQ.reconcilePending();
  ok(eQ.st.managed['8911'] && !eQ.st.pendingOrders['88004'] && puts === 0, '迟到的实例按标签认领，不再创建第二台');

  eQ.st.pendingOrders = { '88005': { at: now - 20 * MIN, state: 'unknown', token: 'miss01', offerId: 88005, machineId: 405, dph: 0.05, gpuName: 'RTX 4070S', numGpus: 1, rentMode: 'interruptible', bid: 0.04, pool: 'pearlhash', pools: ['pearlhash'], mode: 'args' } };
  eQ.rawInstances = [];
  eQ.save();
  const eR = new Engine();
  eR.log = () => {};
  eR.instancesOk = true;
  eR.rawInstances = [];
  eR.instanceListGen = 7;
  eR.instanceListFetchedAt = Date.now() - 10 * MIN;
  ok(eR.st.pendingOrders['88005'], '重启后仍保留未确认的下单');
  let listFetches = 0;
  eR.vast.instances = async () => { listFetches++; return []; };
  await eR.reconcilePending();
  eR.st.pendingOrders['88005'].lastMissAt = Date.now() - 4 * MIN;
  eR.st.pendingOrders['88005'].listMisses = 1;
  await eR.reconcilePending();
  ok(eR.st.pendingOrders['88005'] && listFetches === 0, '同一份缓存空列表隔几分钟再对账，0 次新列表请求，也不会删锁');
  eR.instanceListGen = 8;
  eR.instanceListFetchedAt = Date.now();
  await eR.reconcilePending();
  eR.instanceListGen = 9;
  eR.instanceListFetchedAt = Date.now() + 2 * MIN;
  await eR.reconcilePending();
  ok(eR.st.pendingOrders['88005'], '两份新的空列表也不能证明上次没有创建，锁定继续留着');

  const Econ = await import(U('src/economics.js'));
  const legacyBw = Econ.quoteOffer(
    { dph_total: 0.1, inet_up_cost: 1, inet_down_cost: 1 },
    { disk: 10, targetProfitPct: 30, bidUpliftPct: 3, bandwidthGbPerHour: 0.05, rentMode: 'ondemand' },
    { revenuePerHsHour: 1e-11, hashrateHs: 1e14, mode: 'ondemand' },
  );
  const legacyMissing = Econ.quoteOffer(
    { dph_total: 0.1 },
    { disk: 10, targetProfitPct: 30, bidUpliftPct: 3, bandwidthGbPerHour: 0.05, rentMode: 'ondemand' },
    { revenuePerHsHour: 1e-11, hashrateHs: 1e14, mode: 'ondemand' },
  );
  ok(legacyBw.ok && legacyBw.legacyTotal && Math.abs(legacyBw.dph - 0.2) < 1e-9 && legacyBw.bandwidthHr === 0.1, '没有算力拆分时，已知带宽 $0.1/h 会加到 dph_total $0.1 上');
  ok(!legacyMissing.ok && /带宽/.test(legacyMissing.why || ''), '兼容报价缺带宽仍然拒绝，不会当成 0');

  eQ.updateConfig({ maxHourlySpend: 0.5, maxInstances: 3, minBalanceReserve: 0, runwayGuard: false, autoRent: false });
  eQ.account.vastBalance = 50;
  eQ.rawInstances = [];
  eQ.st.managed = {};
  eQ.reservations = new Map();
  eQ.st.pendingOrders = { other: { at: now, state: 'unknown', token: 'pend35', offerId: 'other', machineId: 501, dph: 0.35, gpuName: 'RTX 4070S', numGpus: 1, rentMode: 'interruptible', bid: 0.3, pool: 'pearlhash', pools: ['pearlhash'], mode: 'args' } };
  puts = 0;
  let budgetSearches = 0;
  eQ.vast.rent = async () => { puts++; return { success: true, new_contract: 9100 }; };
  eQ.vast.searchOffers = async () => { budgetSearches++; return []; };
  let stale = '';
  try { await eQ.rent({ id: 88110, machineId: 510, gpuName: 'RTX 4070S', numGpus: 1, dph: 0.3, th: 122, geolocation: 'Texas, US' }, 'auto', { budgetHr: 0.5 }); }
  catch (err) { stale = err.message; }
  ok(puts === 0 && budgetSearches === 0 && /预算|上限/.test(stale), '自动调用带来的旧预算 $0.5 不能盖过实时剩余 $0.15');

  eQ.st.pendingOrders = {};
  eQ.rawInstances = [{ id: 7001, label: 'prl-auto-RTX4070S pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1, dph_total: 0.2, actual_status: 'running', intended_status: 'running', start_date: now / 1000 - 600, machine_id: 7001 }];
  eQ.st.managed = { '7001': { rentedAt: now - 10 * MIN, gpuName: 'RTX 4070S', numGpus: 1, machineId: 7001, rentMode: 'interruptible', dph: 'nope', bid: null, pool: 'pearlhash' } };
  let unknownBypass = '';
  try { await eQ.rent({ id: 88111, machineId: 511, gpuName: 'RTX 4070S', numGpus: 1, dph: 0.1, th: 122, geolocation: 'Texas, US' }, 'auto', { budgetHr: 0.5 }); }
  catch (err) { unknownBypass = err.message; }
  ok(puts === 0 && /未知|预算|上限/.test(unknownBypass), '费用未知、实时 room 为 0 时，旧 budgetHr 不能放行');
  const ph = eQ.poolsSnapshot(eQ.instances()).find(p => p.id === 'pearlhash');
  ok(ph && ph.spendHr == null, '矿池分面不把未知费用按 0 加进每小时花费');

  const prevPrice = globalThis.__price;
  globalThis.__price = 20;
  await eQ.refreshMarket();
  const raw30 = id => ({
    id, machine_id: 8000 + (id % 100), gpu_name: 'RTX 4070S', num_gpus: 1,
    dph_total: 0.4, min_bid: 0.29, storage_cost: 0.1, inet_up_cost: 0, inet_down_cost: 0,
    search: { diskHour: 0.005 }, reliability2: 0.99, geolocation: 'Texas, US', inet_down: 800, cuda_max_good: 12.6,
  });
  eQ.vast.searchOffers = async (_f, _m, _n, extra) => [raw30(extra?.id || 88120)];
  eQ.refreshVast = async () => {};
  eQ.rawInstances = [];
  eQ.st.managed = {};
  eQ.st.pendingOrders = {};
  eQ.cfg.maxHourlySpend = 0.5;
  eQ.cfg.maxInstances = 3;
  puts = 0;
  eQ.vast.rent = async () => { puts++; return { success: true, new_contract: 9200 + puts }; };
  const firstId = await eQ.rent({ id: 88120, machineId: 520, gpuName: 'RTX 4070S', numGpus: 1, dph: 0.3, th: 122, geolocation: 'Texas, US', autoOk: true }, 'manual');
  const afterFirst = eQ.budget(eQ.instances());
  let secondErr = '';
  try { await eQ.rent({ id: 88121, machineId: 521, gpuName: 'RTX 4070S', numGpus: 1, dph: 0.3, th: 122, geolocation: 'Texas, US', autoOk: true }, 'manual'); }
  catch (err) { secondErr = err.message; }
  ok(puts === 1 && firstId && afterFirst.spend > 0.25 && afterFirst.spend < 0.4 && /预算|上限/.test(secondErr), `成功回包后列表还没有这台时，预算记下约 $${afterFirst.spend.toFixed(3)}/h，第二单不再提交`);

  eQ.cfg.maxInstances = 1;
  eQ.cfg.maxHourlySpend = 5;
  eQ.rawInstances = [{ id: 7300, label: '', gpu_name: 'RTX 4070S', num_gpus: 1, dph_total: 0.05, actual_status: 'running', intended_status: 'running', start_date: now / 1000 - 600, machine_id: 7300 }];
  eQ.st.managed = {};
  eQ.st.pendingOrders = {};
  puts = 0;
  let countErr = '';
  try { await eQ.rent({ id: 88130, machineId: 530, gpuName: 'RTX 4070S', numGpus: 1, dph: 0.05, th: 122, geolocation: 'Texas, US' }, 'manual'); }
  catch (err) { countErr = err.message; }
  ok(puts === 0 && /台数/.test(countErr), '已经有 1 台时，maxInstances=1 的另一笔报价不会 PUT');

  eQ.rawInstances = [];
  eQ.st.pendingOrders = { hold: { at: now, state: 'unknown', token: 'slot', offerId: 'hold', machineId: 531, dph: 0.05, gpuName: 'RTX 4070S', numGpus: 1, rentMode: 'interruptible', bid: 0.04, pool: 'pearlhash', pools: ['pearlhash'], mode: 'args' } };
  let slotErr = '';
  try { await eQ.rent({ id: 88131, machineId: 532, gpuName: 'RTX 4070S', numGpus: 1, dph: 0.05, th: 122, geolocation: 'Texas, US' }, 'manual'); }
  catch (err) { slotErr = err.message; }
  ok(puts === 0 && /台数/.test(slotErr), '未确认订单也占一台名额');

  eQ.st.pendingOrders = {};
  eQ.st.managed = {};
  eQ.cfg.maxInstances = 1;
  eQ.vast.searchOffers = async (_f, _m, _n, extra) => [{ ...raw30(extra?.id), min_bid: 0.04, machine_id: 540 + (extra?.id % 10) }];
  started = 0;
  const raceWait = new Promise(r => { gate = r; });
  eQ.vast.rent = async () => { started++; await raceWait; return { success: true, new_contract: 9300 + started }; };
  const left = eQ.rent({ id: 88140, machineId: 540, gpuName: 'RTX 4070S', numGpus: 1, dph: 0.05, th: 122, geolocation: 'Texas, US' }, 'manual');
  const right = eQ.rent({ id: 88141, machineId: 541, gpuName: 'RTX 4070S', numGpus: 1, dph: 0.05, th: 122, geolocation: 'Texas, US' }, 'manual');
  gate();
  const raced = await Promise.allSettled([left, right]);
  ok(started === 1 && raced.filter(x => x.status === 'fulfilled').length === 1, '两个不同报价同时提交时，台数上限只放行一单');

  eQ.cfg.bootTimeoutMinutes = 12;
  eQ.cfg.maxInstances = 3;
  eQ.rawInstances = [{
    id: 6300, label: 'prl-auto-RTX4070S pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1,
    dph_total: 0.2, actual_status: 'offline', intended_status: 'running', status_msg: 'offline',
    start_date: now / 1000 - 40 * 60, machine_id: 6300,
  }];
  eQ.st.managed = { '6300': { rentedAt: now - 40 * MIN, gpuName: 'RTX 4070S', numGpus: 1, machineId: 6300, rentMode: 'interruptible', bid: 0.05, dph: 0.06, pool: 'pearlhash' } };
  eQ.everHashed.delete('6300');
  eQ.samples.delete('6300');
  killed = null;
  eQ.vast.destroy = async id => { killed = String(id); return { success: true }; };
  await eQ.autoDestroy(eQ.instances());
  ok(killed === '6300' && !eQ.st.blacklist[6300], '未出过算力的可中断 offline 超过开机超时会销毁，但不会拉黑 1440 分钟');

  eQ.rawInstances = [{
    id: 6301, label: 'prl-auto-RTX4070S pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1,
    dph_total: 0.2, actual_status: 'offline', intended_status: 'running', status_msg: 'offline',
    start_date: now / 1000 - 40 * 60, machine_id: 6301,
  }];
  eQ.st.managed = { '6301': { rentedAt: now - 40 * MIN, gpuName: 'RTX 4070S', numGpus: 1, machineId: 6301, rentMode: 'ondemand', dph: 0.2, pool: 'pearlhash' } };
  killed = null;
  await eQ.autoDestroy(eQ.instances());
  ok(killed === '6301' && eQ.st.blacklist[6301] && /部署超时/.test(eQ.st.blacklist[6301].reason || ''), '按需、未出算力、离线超过开机超时仍然拉黑');
  globalThis.__price = prevPrice;

  ok(eQ.cfg.unknownCostMinutes == null, 'unknownCostMinutes 不再参与退租');
  const appJs = fs.readFileSync(path.join(dir, 'public/app.js'), 'utf8');
  ok(appJs.includes('费用未确认，无法估算还能跑多久'), '费用未知且仍有机器时，面板不把续航写成没有计费中的机器');
}

{
  const eH = new Engine();
  eH.log = () => {};
  eH.vast.user = async () => ({ credit: 20 });
  eH.vast.lastListTruncated = false;
  eH.cfg.maxHourlySpend = 1;
  eH.cfg.maxInstances = 2;
  eH.cfg.minBalanceReserve = 0;
  eH.account.vastBalance = 20;
  eH.st.pendingOrders = {};
  eH.st.managed = { '9401': { rentedAt: Date.now() - 10 * MIN, dph: 0.3, gpuName: 'RTX 4070S', numGpus: 1, machineId: 9401, rentMode: 'interruptible', bid: 0.3, offerId: 9401, seenInList: false } };
  eH.rawInstances = [];
  eH.vast.instances = async () => [];
  await eH.refreshVast();
  await eH.refreshVast();
  ok(eH.st.managed['9401'] && eH.budget(eH.instances()).spend > 0.25, '超过 3 分钟、连续两次空列表，未出现的创建记录仍占额');
  eH.st.managed['9401'].seenInList = true;
  await eH.refreshVast();
  await eH.refreshVast();
  ok(eH.st.managed['9401'], '曾出现过的记录也不会因为空列表被自动删掉');
  const actual = eH.summary();
  ok(actual.spendHr > 0.25 && actual.reservedCount === 0 && actual.reservedHr === 0, '已回包但列表没有的机器算实际成本，不是预留');
  eH.st.pendingOrders = { hold: { at: Date.now(), state: 'unknown', dph: 0.2, offerId: 'hold', machineId: 1, gpuName: 'RTX 4070S', numGpus: 1, rentMode: 'interruptible', unknownReason: '结果未知' } };
  const both = eH.summary();
  const bud = eH.budget(eH.instances());
  ok(Math.abs(both.spendHr - actual.spendHr) < 1e-9 && Math.abs(both.reservedHr - 0.2) < 1e-9 && bud.spend > both.spendHr + 0.15 && bud.spend < both.spendHr + 0.25, '面板把预留和实际分开，预算合计不重计');
  eH.st.pendingOrders.hold.dph = null;
  const unknownHold = eH.summary();
  ok(unknownHold.reservedHr == null && unknownHold.reservedUnknown === 1 && unknownHold.spendHr > 0.25, '预留金额未知时显示未知，不写成 0，也不清掉实际成本');
  const view = eH.ordersView();
  ok(view.some(o => o.kind === 'pending' && o.certain === false) && view.some(o => o.kind === 'unlisted' && o.certain === false), '订单状态、金额和时间原因能从快照看到，且不标成已确定');
  let msg = '';
  try { await eH.releasePending('hold', { confirm: false }); } catch (e) { msg = e.message; }
  ok(/确认/.test(msg) && eH.st.pendingOrders.hold, '没有显式确认不会释放');
  try { await eH.releasePending('hold', { confirm: 'true' }); } catch (e) { msg = e.message; }
  ok(/确认/.test(msg) && eH.st.pendingOrders.hold, '非布尔确认无效');
  eH.vast.instances = async () => { throw new Error('down'); };
  try { await eH.releasePending('hold', { confirm: true }); } catch (e) { msg = e.message; }
  ok(/没有释放/.test(msg) && eH.st.pendingOrders.hold, '列表读失败时不释放，订单继续占用');
  eH.vast.instances = async () => [];
  eH.st.pendingOrders.hold.dph = 0.2;
  eH.st.pendingOrders.hold.token = 'absent';
  const gone = await eH.releasePending('hold', { confirm: true });
  ok(gone.released && gone.uncertain && !gone.adopted && !eH.st.pendingOrders.hold, '确认且只读列表没有它时才释放，并标明仍不能证明没创建');
  eH.st.pendingOrders = { late: { at: Date.now(), state: 'unknown', token: 'late02', offerId: 'late', machineId: 9501, dph: 0.2, gpuName: 'RTX 4070S', numGpus: 1, rentMode: 'interruptible', bid: 0.2 } };
  let listCalls = 0;
  eH.vast.instances = async () => {
    listCalls++;
    return [{ id: 9501, label: 'prl-auto-RTX4070S tok=late02 pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1, machine_id: 9501, actual_status: 'loading', start_date: Date.now() / 1000, inet_up_cost: 0, inet_down_cost: 0, storage_cost: 0 }];
  };
  const race = eH.releasePending('late', { confirm: true });
  const other = eH.reconcilePending();
  const adopted = await race;
  await other;
  ok(listCalls >= 1 && adopted.adopted && eH.st.managed['9501'] && !eH.st.pendingOrders.late, '手动释放和迟到列表对账并发时认领，不把已出现的机器释放掉');
  const counted = eH.budget(eH.instances());
  const listed = eH.instances().find(i => i.id === '9501');
  ok(listed && counted.spend > 0 && counted.spend < listed.dph + 0.3 + 0.05, '迟到列表出现后只计一次，不和未出现记录重计');
  const again = await eH.releasePending('late', { confirm: true });
  ok(again.adopted === true && again.released === false && eH.st.managed['9501'], '已经认领后再操作不会释放，也不假装还没处理');
  try { await eH.releaseUnlisted('missing', { confirm: true }); } catch (e) { msg = e.message; }
  ok(/没有这笔/.test(msg) && eH.st.managed['9401'], '无效编号不会动其他记录');
  eH.vast.instances = async () => [];
  const dropped = await eH.releaseUnlisted('9401', { confirm: true });
  ok(dropped.released && dropped.uncertain && !eH.st.managed['9401'], '确认后才停止计入未出现的创建记录');
  eH.st.managed['9402'] = { rentedAt: Date.now(), dph: 0.1, machineId: 9402, gpuName: 'RTX 4070S', numGpus: 1, rentMode: 'interruptible', bid: 0.1, seenInList: true };
  eH.rawInstances = [{ id: 9402, machine_id: 9402, gpu_name: 'RTX 4070S', num_gpus: 1, actual_status: 'running', dph_total: 0.1, inet_up_cost: 0, inet_down_cost: 0 }];
  eH.vast.destroy = async () => { const err = new Error('no such instance'); err.status = 404; throw err; };
  await eH.destroy('9402', '测试退租');
  ok(!eH.st.managed['9402'] && !eH.budget(eH.instances()).costUnknown, '销毁接口明确说实例不存在时删除记录并停止占额');

  eH.st.pendingOrders = { stay: { at: Date.now(), state: 'unknown', dph: 0.05, offerId: 'stay', machineId: 8, gpuName: 'RTX 4070S', numGpus: 1, rentMode: 'interruptible', token: 'stay1' } };
  eH.cfg.maxInstances = 1;
  eH.cfg.autoRent = true;
  await eH.autoRent(eH.instances());
  ok(eH.st.pendingOrders.stay, '自动租用不会把未确认订单释放掉');

  eH.st.pendingOrders = { crash: { at: Date.now(), state: 'inflight', persistedBeforePut: true, dph: 0.05, offerId: 'crash', machineId: 3, token: 'crash1', gpuName: 'RTX 4070S', numGpus: 1, rentMode: 'interruptible' } };
  eH.save();
  const eH2 = new Engine();
  eH2.log = () => {};
  ok(eH2.st.pendingOrders.crash?.state === 'unknown' && /中断/.test(eH2.st.pendingOrders.crash.unknownReason || ''), '重启后，已落盘但结果没写回的订单标成未知');

  const now = Date.now();
  eH2.cfg.minerStartTimeoutMinutes = 10;
  eH2.cfg.bootTimeoutMinutes = 12;
  eH2.st.blacklist = {};
  eH2.rawInstances = [{ id: 9601, label: 'prl-auto-x pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1, actual_status: 'running', intended_status: 'running', status_msg: 'running', start_date: now / 1000 - 120, machine_id: 9601 }];
  eH2.st.managed = { '9601': { rentedAt: now - 2 * MIN, runningAt: now - 11 * MIN, gpuName: 'RTX 4070S', numGpus: 1, machineId: 9601, rentMode: 'interruptible', dph: 0.05, bid: 0.04 } };
  let killed = null;
  eH2.vast.destroy = async id => { killed = String(id); return { success: true }; };
  await eH2.autoDestroy(eH2.instances());
  ok(killed === '9601' && !eH2.st.blacklist[9601], '可中断机器已开机但矿工没上线会销毁，但不拉黑 24 小时');
  eH2.rawInstances = [{ id: 9602, label: 'prl-auto-x pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1, actual_status: 'running', intended_status: 'running', start_date: now / 1000 - 120, machine_id: 9602 }];
  eH2.st.managed = { '9602': { rentedAt: now - 2 * MIN, runningAt: now - 11 * MIN, gpuName: 'RTX 4070S', numGpus: 1, machineId: 9602, rentMode: 'ondemand', dph: 0.05 } };
  killed = null;
  await eH2.autoDestroy(eH2.instances());
  ok(killed === '9602' && eH2.st.blacklist[9602] && eH2.st.blacklist[9602].until - now > 20 * 60 * MIN, '按需机器矿工启动超时仍拉黑约 24 小时');

  await eH2.refreshMarket();
  await eH2.refreshWildrig();
  eH2.account.vastBalance = 50;
  eH2.cfg.maxHourlySpend = 5;
  eH2.cfg.maxInstances = 5;
  eH2.cfg.minBalanceReserve = 0;
  eH2.cfg.autoRent = false;
  eH2.st.managed = {};
  eH2.st.pendingOrders = {};
  eH2.rawInstances = [];
  eH2.vast.searchOffers = async (_f, _m, _n, extra) => [{
    id: extra?.id || 9701, machine_id: 9701, gpu_name: 'RTX 4070S', num_gpus: 1, dph_total: 0.2, min_bid: 0.04,
    storage_cost: 0.1, inet_up_cost: 0, inet_down_cost: 0, search: { diskHour: 0.001 }, reliability2: 0.99,
    geolocation: 'Texas, US', inet_down: 800, cuda_max_good: 12.6,
  }];
  let saw = null;
  eH2.vast.rent = async () => {
    const p = eH2.st.pendingOrders['9701'];
    saw = { state: p?.state, persisted: p?.persistedBeforePut };
    const err = new Error('超时');
    err.status = 0;
    throw err;
  };
  try { await eH2.rent({ id: 9701, machineId: 9701, gpuName: 'RTX 4070S', numGpus: 1, dph: 0.05, th: 122, geolocation: 'Texas, US' }, 'manual'); } catch {}
  ok(saw?.persisted === true && saw?.state === 'inflight' && eH2.st.pendingOrders['9701']?.state === 'unknown', '创建请求发出前订单已落盘；结果未知后仍保留，不会变成可再下单的空记录');
}

{
  const eZ = new Engine();
  eZ.log = () => {};
  await eZ.refreshMarket(); await eZ.refreshWildrig();
  const prevPrice = globalThis.__price;
  globalThis.__price = 20;
  await eZ.refreshMarket();
  eZ.account.vastBalance = 50;
  eZ.cfg.maxHourlySpend = 0.5;
  eZ.cfg.maxInstances = 3;
  eZ.cfg.minBalanceReserve = 0;
  eZ.cfg.autoRent = false;
  eZ.st.managed = {};
  eZ.st.pendingOrders = {};
  eZ.st.orderHistory = [];
  eZ.rawInstances = [];
  eZ.reservations = new Map();
  eZ.vast.lastListTruncated = false;
  eZ.vast.instances = async () => [];
  eZ.vast.searchOffers = async (_f, _m, _n, extra) => [{
    id: extra?.id, machine_id: 800 + (Number(extra?.id) % 50), gpu_name: 'RTX 4070S', num_gpus: 1,
    dph_total: 0.4, min_bid: 0.29, storage_cost: 0.1, inet_up_cost: 0, inet_down_cost: 0,
    search: { diskHour: 0.005 }, reliability2: 0.99, geolocation: 'Texas, US', inet_down: 800, cuda_max_good: 12.6,
  }];
  let releasePut;
  const hung = new Promise(r => { releasePut = r; });
  let puts = 0;
  eZ.vast.rent = async () => { puts++; if (puts === 1) return hung; return { success: true, new_contract: 9800 + puts }; };
  const first = eZ.rent({ id: 9801, machineId: 801, gpuName: 'RTX 4070S', numGpus: 1, dph: 0.05, th: 122, geolocation: 'Texas, US' }, 'manual');
  for (let i = 0; i < 50 && !eZ.st.pendingOrders['9801']; i++) await new Promise(r => setTimeout(r, 10));
  const saved = eZ.st.pendingOrders['9801'];
  ok(saved?.state === 'inflight' && saved.dph > 0.25, `复核后的合计 $${saved?.dph} 已落盘，创建请求仍挂起`);
  let blocked = '';
  try { await eZ.releasePending('9801', { confirm: true }); } catch (e) { blocked = e.message; }
  ok(/还在本次运行/.test(blocked) && eZ.st.pendingOrders['9801'], '在途创建不能被人工释放');
  const mid = eZ.budget(eZ.instances());
  ok(mid.spend > 0.25 && mid.spend < 0.4, '挂起期间按复核后的金额占额，不退回报价前的 $0.05');
  const putsAtHang = puts;
  try { await eZ.rent({ id: 9802, machineId: 802, gpuName: 'RTX 4070S', numGpus: 1, dph: 0.3, th: 122, geolocation: 'Texas, US' }, 'manual'); } catch {}
  ok(puts === putsAtHang, '上限 $0.50 时，在途约 $0.30 挡住另一笔 $0.30');
  const tok = eZ.st.pendingOrders['9801'].token;
  eZ.rawInstances = [{ id: 9810, label: `prl-auto-RTX4070S tok=${tok} pool=pearlhash`, gpu_name: 'RTX 4070S', num_gpus: 1, machine_id: 801, actual_status: 'loading', start_date: Date.now() / 1000, inet_up_cost: 0, inet_down_cost: 0, storage_cost: 0 }];
  await eZ.reconcilePending();
  const during = eZ.budget(eZ.instances());
  ok(eZ.st.managed['9810'] && !eZ.st.pendingOrders['9801'] && during.reservedCount === 0 && during.roomCount === 2, '列表先出现后，旧预留不再和实际重复占额');
  releasePut({ success: true, new_contract: 9810 });
  await first.catch(() => {});
  eZ.st.managed = { '9707': { rentedAt: Date.now(), dph: 0.1, machineId: 707, gpuName: 'RTX 4070S', numGpus: 1, rentMode: 'interruptible', bid: 0.1 } };
  eZ.rawInstances = [{ id: 9707, machine_id: 707, gpu_name: 'RTX 4070S', num_gpus: 1, actual_status: 'running' }];
  eZ.vast.destroy = async () => ({ success: false, error: 'still_running' });
  let dmsg = '';
  try { await eZ.destroy('9707', '测试'); } catch (e) { dmsg = e.message; }
  ok(/still_running/.test(dmsg) && eZ.st.managed['9707'], 'HTTP 200 且 success:false 不删账');
  eZ.vast.destroy = async () => ({ weird: true });
  try { await eZ.destroy('9707', '测试'); } catch (e) { dmsg = e.message; }
  ok(/不明确/.test(dmsg) && eZ.st.managed['9707'], '看不懂的销毁回包保留账本');
  eZ.vast.destroy = async () => ({ success: true });
  await eZ.destroy('9707', '测试');
  ok(!eZ.st.managed['9707'], '明确 success:true 才删除');
  eZ.st.managed['9708'] = { rentedAt: Date.now(), dph: 0.1, machineId: 708, gpuName: 'RTX 4070S', numGpus: 1 };
  eZ.vast.destroy = async () => { const err = new Error('HTTP 404：no such instance'); err.status = 404; throw err; };
  await eZ.destroy('9708', '测试');
  ok(!eZ.st.managed['9708'], '明确 404 是终态');
  eZ.st.pendingOrders = { '78': { at: Date.now(), state: 'unknown', dph: 0.05, offerId: '78', token: 'k78', machineId: 78, gpuName: 'RTX 4070S', numGpus: 1, rentMode: 'interruptible', bid: 0.04 } };
  let bad = '';
  try { await eZ.releasePending(['78'], { confirm: true }); } catch (e) { bad = e.message; }
  ok(/无效/.test(bad) && eZ.ownPending('78'), '数组编号不能释放对应字符串订单');
  eZ.st.pendingOrders = {};
  let proto = null;
  try { proto = await eZ.releasePending('__proto__', { confirm: true }); } catch (e) { bad = e.message; }
  ok(proto == null && /无效/.test(bad) && proto?.released !== true, '原型键不能被当成订单释放');
  eZ.st.pendingOrders = { once: { at: Date.now(), state: 'unknown', dph: 0.05, offerId: 'once', token: 'once1', machineId: 11, gpuName: 'RTX 4070S', numGpus: 1, rentMode: 'interruptible', bid: 0.04 } };
  eZ.st.managed = {};
  eZ.vast.instances = async () => [];
  const pair = await Promise.all([eZ.releasePending('once', { confirm: true }), eZ.releasePending('once', { confirm: true })]);
  ok(pair.filter(x => x.released).length === 1 && !pair.some(x => x.adopted) && pair.some(x => x.already), '并发释放只成功一次，第二次不报认领');
  eZ.rawInstances = [];
  eZ.st.managed = {};
  eZ.st.pendingOrders = {};
  ok((eZ.st.orderHistory || []).some(h => h.token === 'once1') && !(eZ.budget(eZ.instances()).spend > 0), '释放历史不占预算');
  eZ.rawInstances = [{ id: 9911, label: 'prl-auto-RTX4070S tok=once1 pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1, machine_id: 11, actual_status: 'running', dph_total: 1.5, inet_up_cost: 0, inet_down_cost: 0, storage_cost: 0 }];
  const live = eZ.instances().find(i => i.id === '9911');
  const again = eZ.budget(eZ.instances());
  ok(eZ.st.managed['9911']?.rentMode === 'interruptible' && eZ.st.managed['9911']?.bid === 0.04 && live && live.dph < 0.2 && again.spend > 0 && again.spend < 0.2, '晚到的同一标签用记下的出价，不用 dph_total，且只占一次');
  eZ.st.pendingOrders = { crash2: { at: Date.now(), state: 'inflight', dph: 0.3, offerId: 'crash2', token: 'c2', machineId: 2, gpuName: 'RTX 4070S', numGpus: 1, rentMode: 'interruptible', bid: 0.29 } };
  eZ.st.managed = {};
  eZ.save();
  const eZ2 = new Engine();
  eZ2.log = () => {};
  ok(eZ2.st.pendingOrders.crash2?.state === 'unknown' && eZ2.st.pendingOrders.crash2.dph === 0.3, '崩溃后订单还在，金额仍是复核后的合计');
  globalThis.__price = prevPrice;
}

{
  const eN = new Engine();
  eN.log = () => {};
  const now = Date.now();
  eN.cfg.pausedDestroyMinutes = 3;
  eN.cfg.maxInstances = 2;
  eN.cfg.maxHourlySpend = 1;
  const rig = id => ({
    id, label: 'prl-auto-x pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1,
    actual_status: 'exited', intended_status: 'stopped', status_msg: 'stopped',
    start_date: now / 1000 - 3600, machine_id: id, dph_total: 0.2,
  });
  eN.rawInstances = [rig(101), rig(102)];
  eN.st.managed = {
    '101': { rentedAt: now - 60 * MIN, dph: 0.1, machineId: 101, gpuName: 'RTX 4070S', numGpus: 1, pausedSince: now - 10 * MIN, rentMode: 'interruptible', bid: 0.1 },
    '102': { rentedAt: now - 60 * MIN, dph: 0.1, machineId: 102, gpuName: 'RTX 4070S', numGpus: 1, pausedSince: now - 10 * MIN, rentMode: 'interruptible', bid: 0.1 },
  };
  const calls = [];
  eN.vast.destroy = async id => {
    calls.push(String(id));
    if (String(id) === '101') return { success: false, error: 'still_running' };
    return { success: true };
  };
  await eN.autoDestroy(eN.instances());
  ok(calls.includes('101') && calls.includes('102') && eN.st.managed['101'] && !eN.st.managed['102'], '第一台销毁业务失败后第二台仍退租，失败的那台保留账本');

  eN.rawInstances = [];
  eN.st.managed = { '301': { offerId: '77', orderToken: 'old', dph: 0.3, rentedAt: now, gpuName: 'RTX 4070S', numGpus: 1, machineId: 301, rentMode: 'interruptible', bid: 0.3 } };
  eN.st.pendingOrders = { '77': { at: now, state: 'unknown', dph: 0.3, offerId: '77', token: 'new', machineId: 77, gpuName: 'RTX 4070S', numGpus: 1 } };
  const bN = eN.budget(eN.instances());
  ok(bN.reservedCount === 1 && bN.roomCount === 0 && bN.spend > 0.55, '同一 offer 的新未确认订单仍占额、占名额');

  eN.st.orderHistory = [];
  eN.st.pendingOrders = {};
  eN.st.managed = {};
  for (let i = 0; i <= 40; i++) eN.rememberRelease({ token: 't' + i, dph: 0.19, bid: 0.19, rentMode: 'interruptible', offerId: 'h' + i, at: now, gpuName: 'RTX 4070S', numGpus: 1 }, 'h' + i);
  ok(eN.st.orderHistory.length === 40 && !eN.st.orderHistory.some(h => h.token === 't0'), '释放历史超过 40 条后最早的标签被挤出');
  eN.rawInstances = [{
    id: 801, label: 'prl-auto-RTX4070S tok=t0 pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1,
    machine_id: 801, actual_status: 'running', intended_status: 'running', dph_total: 2,
    inet_up_cost: 0, inet_down_cost: 0, storage_cost: 0, start_date: now / 1000 - 7200,
  }];
  eN.samples.set('801', [0, 1, 2, 3, 4, 5].map(k => ({ t: now - (6 - k) * MIN, hs: 50e12 })));
  eN.everHashed.add('801');
  eN.cfg.stopLossPct = 12;
  eN.cfg.stopLossMinutes = 1;
  eN.cfg.hashWarmupMinutes = 0;
  eN.market.updatedAt = Date.now();
  const lost = eN.instances().find(i => i.id === '801');
  const budLost = eN.budget(eN.instances());
  let floorKilled = [];
  eN.vast.destroy = async id => { floorKilled.push(String(id)); return { success: true }; };
  await eN.autoDestroy(eN.instances());
  ok(lost && lost.managed && lost.costKnown === false && lost.dph == null && budLost.costUnknown === true && budLost.roomSpend === 0 && budLost.spend < 0.01 && !floorKilled.includes('801'), '对不上释放历史时费用未知，占一台且不按 dph_total 止损');

  eN.rawInstances = [{
    id: 802, label: 'prl-auto-RTX4070S tok=deadbeef pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1,
    machine_id: 802, actual_status: 'running', intended_status: 'running', dph_total: 0.4,
    inet_up_cost: 0, inet_down_cost: 0, storage_cost: 0, start_date: now / 1000 - 3600,
  }];
  eN.st.managed = {};
  const stranger = eN.instances().find(i => i.id === '802');
  const budStranger = eN.budget(eN.instances());
  ok(stranger && stranger.managed === false && stranger.costKnown === true && stranger.dph === 0.4 && budStranger.costUnknown === false, '不是本程序发出的标签不算托管，也不占用未知费用');

  eN.st.issuedOrders = {};
  eN.noteIssued('a000', { at: now, rentMode: 'interruptible', offerId: '88' });
  eN.st.pendingOrders = { '88': { at: now, state: 'unknown', token: 'a000', dph: 0.3, bid: 0.3, offerId: '88', rentMode: 'interruptible', gpuName: 'RTX 4070S', numGpus: 1 } };
  eN.rawInstances = [{
    id: 803, label: 'prl-auto-RTX4070S tok=a000 pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1,
    machine_id: 803, actual_status: 'running', intended_status: 'running', dph_total: 9,
    inet_up_cost: 0, inet_down_cost: 0, storage_cost: 0, start_date: now / 1000 - 3600,
  }];
  eN.st.managed = {};
  const budOnce = eN.budget(eN.instances());
  ok(budOnce.reservedCount === 0 && budOnce.count === 1 && budOnce.spend > 0.25 && budOnce.spend < 0.5, '同一标签的未确认订单和已出现实例只占一次');

  const armZero = (e, id, mode) => {
    e.rawInstances = [{
      id, label: 'prl-auto-RTX4070S pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1,
      actual_status: 'running', intended_status: 'running', dph_total: 0.2, machine_id: id,
      start_date: now / 1000 - 7200, inet_up_cost: 0, inet_down_cost: 0, storage_cost: 0,
    }];
    e.st.managed = { [String(id)]: { rentedAt: now - 60 * MIN, dph: 0.1, bid: 0.1, rentMode: mode, hashAt: now - 40 * MIN, gpuName: 'RTX 4070S', numGpus: 1, machineId: id } };
    e.samples.set(String(id), [{ t: now - 20 * MIN, hs: 40e12 }, ...Array.from({ length: 12 }, (_, k) => ({ t: now - (12 - k) * MIN, hs: 0 }))]);
    e.everHashed.add(String(id));
    e.workersOk = true;
    e.st.blacklist = {};
  };
  armZero(eN, 501, 'interruptible');
  await eN.autoDestroy(eN.instances());
  ok(!eN.st.managed['501'] && !eN.st.blacklist[501], '可中断实例持续零算力会退租，但不拉黑主机');
  armZero(eN, 502, 'ondemand');
  await eN.autoDestroy(eN.instances());
  ok(!eN.st.managed['502'] && eN.st.blacklist[502] && eN.st.blacklist[502].until - now > 5 * 60 * MIN, '按需实例持续零算力仍拉黑约 6 小时');

  const armStale = (e, id, mode) => {
    e.rawInstances = [{
      id, label: 'prl-auto-RTX4070S pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1,
      actual_status: 'running', intended_status: 'running', dph_total: 0.2, machine_id: id,
      start_date: now / 1000 - 7200, inet_up_cost: 0, inet_down_cost: 0, storage_cost: 0,
    }];
    e.st.managed = { [String(id)]: { rentedAt: now - 60 * MIN, dph: 0.1, bid: 0.1, rentMode: mode, hashAt: now - 60 * MIN, staleSince: now - 20 * MIN, gpuName: 'RTX 4070S', numGpus: 1, machineId: id } };
    e.samples.set(String(id), [{ t: now - 10 * MIN, hs: 40e12 }]);
    e.everHashed.add(String(id));
    e.workersOk = true;
    e.st.blacklist = {};
  };
  armStale(eN, 503, 'interruptible');
  await eN.autoDestroy(eN.instances());
  ok(!eN.st.managed['503'] && !eN.st.blacklist[503], '可中断实例样本过期会退租，但不拉黑主机');
  armStale(eN, 504, 'ondemand');
  await eN.autoDestroy(eN.instances());
  ok(!eN.st.managed['504'] && eN.st.blacklist[504] && eN.st.blacklist[504].until - now > 5 * 60 * MIN, '按需实例样本过期仍拉黑约 6 小时');

  const stopped = id => ({
    id, label: 'prl-auto-x pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1,
    actual_status: 'exited', intended_status: 'stopped', status_msg: 'stopped',
    start_date: now / 1000 - 3600, machine_id: id, dph_total: 0.2,
  });
  eN.rawInstances = [stopped(601), stopped(602)];
  eN.st.managed = {
    '601': { rentedAt: now - 60 * MIN, dph: 0.1, bid: 0.1, rentMode: 'interruptible', pausedSince: now - 10 * MIN, gpuName: 'RTX 4070S', numGpus: 1, machineId: 601 },
    '602': { rentedAt: now - 60 * MIN, dph: 0.1, bid: 0.1, rentMode: 'interruptible', pausedSince: now - 10 * MIN, gpuName: 'RTX 4070S', numGpus: 1, machineId: 602 },
  };
  const seen = [];
  eN.vast.destroy = async id => {
    seen.push(String(id));
    if (String(id) === '601') {
      const err = new Error('HTTP 400：invalid instance_id');
      err.status = 400;
      err.body = { success: false, error: 'invalid_args', msg: 'invalid instance_id' };
      throw err;
    }
    return { success: true };
  };
  await eN.autoDestroy(eN.instances());
  ok(seen.includes('601') && seen.includes('602') && eN.st.managed['601'] && !eN.st.managed['602'], '文档里的 400 参数错误保留账本，下一台仍继续');
  eN.rawInstances = [stopped(603)];
  eN.st.managed['603'] = { rentedAt: now - 60 * MIN, dph: 0.1, bid: 0.1, rentMode: 'interruptible', pausedSince: now - 10 * MIN, gpuName: 'RTX 4070S', numGpus: 1, machineId: 603 };
  eN.vast.destroy = async () => {
    const err = new Error('HTTP 404：Instance not found');
    err.status = 404;
    err.body = { success: false, error: 'not_found', msg: 'Instance not found' };
    throw err;
  };
  await eN.autoDestroy(eN.instances());
  ok(!eN.st.managed['603'], '文档里的 404 not_found 只清这一台的账');

  eN.rawInstances = [{
    id: 701, label: 'prl-auto-RTX4070S pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1,
    actual_status: 'running', intended_status: 'running', dph_total: 0.2, machine_id: 701,
    start_date: now / 1000 - 7200, inet_up_cost: 0, inet_down_cost: 0, storage_cost: 0,
  }];
  eN.st.managed = { '701': { rentedAt: now - 60 * MIN, dph: 0.2, bid: 0.2, rentMode: 'interruptible', hashAt: now - 60 * MIN, belowSince: now - 30 * MIN, gpuName: 'RTX 4070S', numGpus: 1, machineId: 701 } };
  eN.samples.set('701', [0, 1, 2, 3, 4, 5].map(k => ({ t: now - (6 - k) * MIN, hs: 1e12 })));
  eN.everHashed.add('701');
  eN.cfg.stopLossPct = 12;
  eN.cfg.stopLossMinutes = 12;
  eN.cfg.hashWarmupMinutes = 0;
  eN.market.updatedAt = Date.now();
  eN.st.blacklist = {};
  eN.vast.destroy = async () => ({ success: true });
  await eN.autoDestroy(eN.instances());
  ok(!eN.st.managed['701'] && !eN.st.blacklist[701], '可中断实例低于利润底线会退租，但不拉黑主机');
}

{
  const eI = new Engine();
  eI.log = () => {};
  eI.instancesOk = true;
  eI.st.issuedOrders = {};
  eI.st.orderHistory = [];
  eI.st.pendingOrders = {};
  eI.st.managed = {};
  const now = Date.now();
  eI.rawInstances = [{
    id: 1, label: 'prl-auto-RTX4070S tok=cap0 pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1,
    actual_status: 'running', intended_status: 'running', dph_total: 9, machine_id: 1,
    inet_up_cost: 0, inet_down_cost: 0, storage_cost: 0, start_date: now / 1000 - 3600,
  }];
  for (let i = 0; i <= 2000; i++) eI.noteIssued('cap' + i, { at: i, dph: i === 0 ? 0.19 : 0.01, bid: 0.19, rentMode: 'interruptible' });
  const kept = eI.instances().find(i => i.id === '1');
  ok(eI.tokenIsOurs('cap0') && !eI.tokenIsOurs('cap1') && kept && kept.managed && kept.costKnown && kept.dph != null && kept.dph < 5, '还在列表上的标签不会被身份上限挤掉，并使用记下的出价');

  eI.rawInstances = [{
    id: 2, label: 'prl-auto-RTX4070S tok=bare pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1,
    actual_status: 'running', intended_status: 'running', dph_total: 9, machine_id: 2,
    inet_up_cost: 0, inet_down_cost: 0, storage_cost: 0, start_date: now / 1000 - 3600,
  }];
  eI.st.managed = {};
  eI.noteIssued('bare', { at: now, rentMode: 'interruptible' });
  const bare = eI.instances().find(i => i.id === '2');
  const before = eI.budget(eI.instances());
  let floor = false;
  eI.vast.destroy = async () => { floor = true; return { success: true }; };
  eI.samples.set('2', [0, 1, 2, 3, 4, 5].map(k => ({ t: now - (6 - k) * MIN, hs: 40e12 })));
  eI.everHashed.add('2');
  eI.cfg.stopLossPct = 12; eI.cfg.stopLossMinutes = 1; eI.cfg.hashWarmupMinutes = 0;
  eI.market.updatedAt = Date.now();
  await eI.autoDestroy(eI.instances());
  ok(bare && bare.managed && bare.costKnown === false && before.roomSpend === 0 && before.costUnknown && !floor, '有身份但没有出价时占未知费用，利润底线不销毁');
  await eI.setInstancePrice('2', { dph: 0.11, bid: 0.11, rentMode: 'interruptible', confirm: true });
  const after = eI.budget(eI.instances());
  ok(after.costUnknown === false && after.roomSpend > 0 && eI.instances().find(i => i.id === '2').dph != null, '补录出价后恢复可租额度，不必先销毁');

  eI.rawInstances = [{ id: 42, label: 'prl-auto-RTX4070S pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1, actual_status: 'running', dph_total: 3, machine_id: 42, start_date: now / 1000 - 600 }];
  eI.st.managed = {};
  eI.st.issuedOrders = {};
  ok(eI.instances().find(i => i.id === '42').managed === false, '没有本地身份记录时，相近前缀不会自动认领');
  let claimErr = '';
  try { await eI.claimInstance('42', { dph: 0.2 }); } catch (e) { claimErr = e.message; }
  ok(/确认/.test(claimErr), '手工认领必须显式确认');
  await eI.claimInstance('42', { dph: 0.2, rentMode: 'interruptible', confirm: true });
  ok(eI.st.managed['42'] && eI.st.managed['42'].claimedManually && eI.st.managed['42'].dph === 0.2, '确认并填写费用后才能手工认领');

  eI.st.managed = { '77': { dph: 0.25, bid: 0.25, rentMode: 'interruptible', gpuName: 'RTX 4070S', numGpus: 1 } };
  eI.rawInstances = [];
  let calls = 0;
  eI.vast.destroy = async () => { calls++; return { success: false, error: 'still_running' }; };
  for (let n = 0; n < 3; n++) { try { await eI.destroy('77', '重试'); } catch {} }
  const stuck = eI.attention().destroyStuck.find(x => x.id === '77');
  try { await eI.destroy('77', '重试'); } catch {}
  ok(eI.st.managed['77'] && eI.st.managed['77'].destroyFails === 3 && calls === 3 && stuck && stuck.fails === 3, '文档没写的销毁正文保留账本，并露出失败次数，连续失败后先停自动重试');
  eI.vast.destroy = async () => {
    const err = new Error('HTTP 400：not found 404');
    err.status = 400;
    err.body = { success: false, error: 'invalid_args', msg: 'not found 404' };
    throw err;
  };
  eI.st.managed['78'] = { dph: 0.2, rentMode: 'ondemand' };
  let badClear = false;
  try { await eI.destroy('78', '参数错误', 0, { force: true }); } catch { badClear = true; }
  ok(badClear && eI.st.managed['78'], '400 正文里的 404 或 not found 不清账');
  const dropped = await eI.releaseUnlisted('77', { confirm: true });
  ok(dropped.released && !eI.st.managed['77'], '不在列表里的占额可以确认停止计入');

  eI.st.managed = { '5': { orderToken: 'abc1', dph: 0.2, bid: 0.2, rentMode: 'interruptible', offerId: '9', rentedAt: now, gpuName: 'RTX 4070S', numGpus: 1 } };
  eI.rawInstances = [];
  eI.st.orderHistory = [];
  await eI.releaseUnlisted('5', { confirm: true });
  ok(eI.st.orderHistory.at(-1)?.token === 'abc1' && eI.st.orderHistory.at(-1)?.dph === 0.2, '停止计入时写下真实的订单标签和出价');

  eI.rawInstances = [{
    id: 8, label: 'prl-auto-RTX4070S tok=abcd pool=kryptex', gpu_name: 'RTX 4070S', num_gpus: 1,
    actual_status: 'running', intended_status: 'running', dph_total: 0.2, machine_id: 8, start_date: now / 1000 - 7200,
  }];
  eI.st.managed = { '8': { sw: { from: 'pearlhash', to: 'kryptex', at: now - 20 * MIN }, orderToken: 'abcd', hashAt: now - 60 * MIN, rentMode: 'interruptible', dph: 0.1, bid: 0.1, gpuName: 'RTX 4070S', numGpus: 1 } };
  eI.poolConfigured = () => true;
  eI.fetchLogs = async () => ({ t: now, text: '' });
  let rolled = '';
  eI.vast.setLabel = async (_id, label) => { rolled = label; };
  await eI.checkSwitches(eI.instances());
  ok(/tok=abcd/.test(rolled) && /pool=pearlhash/.test(rolled), '切换失败改回原矿池时保留 tok=');

  eI.workersOk = true;
  eI.rawInstances = [{
    id: 9, label: 'prl-auto-RTX4070S pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1,
    actual_status: 'running', intended_status: 'running', dph_total: 0.2, machine_id: 9,
    start_date: now / 1000 - 7200, inet_up_cost: 0, inet_down_cost: 0, storage_cost: 0,
  }];
  eI.st.managed = { '9': { rentedAt: now - 60 * MIN, dph: 0.1, bid: 0.1, rentMode: null, restoredFromIdentity: true, hashAt: now - 40 * MIN, gpuName: 'RTX 4070S', numGpus: 1, machineId: 9 } };
  eI.samples.set('9', [{ t: now - 20 * MIN, hs: 40e12 }, ...Array.from({ length: 12 }, (_, k) => ({ t: now - (12 - k) * MIN, hs: 0 }))]);
  eI.everHashed.add('9');
  eI.st.blacklist = {};
  eI.vast.destroy = async () => ({ success: true });
  await eI.autoDestroy(eI.instances());
  ok(!eI.st.managed['9'] && !eI.st.blacklist[9], '恢复记录没有租用方式时不按按需拉黑');

  eI.rawInstances = [{
    id: 3, label: 'prl-auto-RTX4070S tok=zz9 pool=pearlhash', gpu_name: 'RTX 4070S', num_gpus: 1,
    actual_status: 'exited', intended_status: 'stopped', dph_total: 2, machine_id: 3, start_date: now / 1000 - 3600,
  }];
  eI.st.managed = {};
  eI.st.pendingOrders = {};
  eI.noteIssued('zz9', { at: now, rentMode: 'interruptible' });
  const shown = eI.summary(eI.instances());
  eI.st.pendingOrders = { zz: { token: 'zz9', dph: 0.2, state: 'unknown', offerId: 'zz' } };
  const slot = eI.ordersView().find(o => o.kind === 'pending');
  ok(shown.count >= 1 && slot && slot.occupiesSlot === false, '停止中的未知费用会计入台数，已出现的订单不再显示另占一台');
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
