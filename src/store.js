// 本地存储：data/config.json（设置+密钥，只存在你电脑上）、data/state.json（运行状态）
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const DEFAULT_CONFIG = {
  vastApiKey: '',
  wallet: '',               // Pearlhash 用的 PRL 钱包
  kryptexWallet: '',        // Kryptex 用的 PRL 钱包（可以和上面不同，方便分开统计收益）
  defaultPool: 'pearlhash', // 自动/手动租用时默认挖哪个矿池
  failover: true,           // 默认矿池故障时，把机器自动切到另一个矿池，恢复后切回
  failoverMinutes: 5,       // 故障持续多久才切
  nockAddress: '',          // 可选：Nockchain 收款地址，矿池会额外分 NOCK
  includeNock: true,        // 矿池已登记 NOCK 地址时，把 NOCK 收益计入利润
  // —— 核心 4 项 ——
  targetProfitPct: 30,      // 达到这个收益率（利润÷租金）才租
  // 利润底线：收益率低于它就退出。正数是底线（12 = 利润不足 12% 就退），不是「允许亏 12%」。
  // 负数才表示容忍亏损。字段名仍是 stopLossPct，旧配置不用改名。
  stopLossPct: 12,
  maxInstances: 5,          // 最多同时租几台
  maxHourlySpend: 2,        // 所有机器加起来每小时最多花多少美元
  // —— 开关 ——
  autoRent: false,          // 自动租用（默认关闭，先观察；不会自动花钱）
  autoDestroy: true,        // 自动退租（无算力 / 低于利润底线）
  // interruptible = vast type "bid"；ondemand = type "on-demand"。新搜索默认可中断，按需仍可显式选择。
  rentMode: 'interruptible',
  bidUpliftPct: 3,          // 在文档中的 min_bid（美元/小时）上浮，默认 3%（建议 2–5），再被经济上限和预算截断
  // —— 高级（一般不用改）——
  minBalanceReserve: 2,     // 余额低于它就停止新租
  runwayGuard: false,       // 续航保护开关（默认关闭，在设置里打开）
  minRunwayHours: 12,       // 余额必须够所有机器再跑这么多小时，否则停止新租
  stopLossMinutes: 12,      // 低于利润底线持续多久才退租
  bootTimeoutMinutes: 12,   // 租下（或重启）后多久还没算力就判定部署失败并退租
  minerStartTimeoutMinutes: 10, // 机器开机后多久矿工还没上线就判定失败（建议 8–10 分钟）
  hashWarmupMinutes: 4,     // 刚出算力的短预热，避免爬坡噪声触发利润底线
  negativeExitMinutes: 5,   // 保守满算力仍然亏钱时，不必等满底线计时
  staleHashMinutes: 3,      // 算力样本比这更旧就不当成当前算力
  unknownCostMinutes: 15,   // 跑着但费用数字无效，超过这个时间退出
  pausedDestroyMinutes: 3,  // 已停止/被抢占的实例仍可能计存储费，超时销毁，不拉黑主机
  hashLowPct: 80,           // 实测算力低于预期的这个百分比就标为异常
  minReliability: 0.95,
  minInetDown: 200,         // 下行带宽太低的机器拉镜像要十几分钟以上
  maxGpusPerMachine: 8,
  minCuda: 12.4,
  disk: 10,
  scanIntervalSec: 600,     // 慢扫描基线。热窗口才允许更快，且不能快过额度分摊
  scanRows: 20,             // 一轮搜索的条数预算（各型号最低价合计，大约 20）
  scanMaxProbes: 8,         // 一轮最多按型号查几次，避免热扫描打满请求频率
  hotScanIntervalSec: 45,   // 热窗口里的快扫描，限制在 30–60 秒
  hotScanTtlSec: 180,       // 热窗口墙钟上限，到点必须停
  hotMaxScans: 4,           // 热窗口最多几次搜索，防止条件一直成立时刷额度
  hotCooldownSec: 600,      // 热窗口结束后的冷却，冷却期内不能再次打开
  revenueHotPct: 3,         // 收益至少上升这么多（百分比）才因「收益变好」打开热窗口
  bandwidthGbPerHour: 0.05, // 把美元/GB 的流量价折进时租的用量上限，不是实测流量
  poolUrl: 'stratum+ssl://pool.pearlhash.xyz:9443',
  image: 'vastai/base-image:cuda-12.4.1-auto',
  launchMode: 'args',       // args = 快速启动（跳过 SSH 初始化，不能 SSH 登录）；ssh = 可以 SSH 登录但开机慢
  minerArgs: '',
  proxy: '',
  port: 8290,
};

const cfgFile = path.join(DATA_DIR, 'config.json');
const stateFile = path.join(DATA_DIR, 'state.json');

function readJson(f, def) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; }
}
function writeJson(f, v) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, f);
}

// 设置页保存时会把所有字段写进 config.json，导致之后改了默认值也不生效。
// 这里把「仍等于旧默认值」的项升级成新默认值；用户自己改过的值保持不变。
const UPGRADES = [
  { v: 2, key: 'minInetDown', from: 20, to: 200 },
  { v: 2, key: 'scanIntervalSec', from: 180, to: 300 },
  // v3：只升级「仍然等于上一版默认值」的项。用户改过的值保持原样。
  // 规则按顺序作用在已经升级过的 cfg 上，所以 180 → 300 → 600 会接上。
  { v: 3, key: 'scanIntervalSec', from: 300, to: 600 },
  { v: 3, key: 'scanRows', from: 100, to: 20 },
  { v: 3, key: 'stopLossPct', from: 0, to: 12 },
  { v: 3, key: 'stopLossMinutes', from: 30, to: 12 },
  { v: 3, key: 'bootTimeoutMinutes', from: 20, to: 12 },
  { v: 3, key: 'minerStartTimeoutMinutes', from: 8, to: 10 },
];
const CONFIG_VERSION = 3;
export function loadConfig() {
  const saved = readJson(cfgFile, {});
  const cfg = { ...DEFAULT_CONFIG, ...saved };
  const ver = saved.configVersion || 1;
  if (ver < CONFIG_VERSION) {
    for (const u of UPGRADES) if (ver < u.v && cfg[u.key] === u.from) cfg[u.key] = u.to;
    cfg.configVersion = CONFIG_VERSION;
    try { writeJson(cfgFile, cfg); } catch {}
  }
  return cfg;
}
export function saveConfig(c) { writeJson(cfgFile, c); }

export function loadState() {
  return {
    managed: {},     // instanceId -> { offerId, machineId, gpuName, numGpus, expectedTh, rentedAt, belowSince }
    blacklist: {},   // machineId -> { until, reason }
    calib: {},       // gpuKey -> { th, samples }
    history: [],     // [{ t, price, netEh, usdPerThDay, spend, revenue }]
    ...readJson(stateFile, {}),
  };
}
export function saveState(s) { writeJson(stateFile, s); }

const logFile = path.join(DATA_DIR, 'events.log');
export function appendLog(line) {
  try { fs.appendFileSync(logFile, line + '\n'); } catch {}
}
