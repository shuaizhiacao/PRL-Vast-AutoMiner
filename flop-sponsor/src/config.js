import fs from 'node:fs';
import { Stop } from './errors.js';

// 创世哈希来自运营方给出的 devnet 值，启动时还要和链上 chain_getBlockHash(0) 对照。
export const DEVNET_GENESIS = '0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631';

export const DEFAULTS = {
  dryRun: true,
  autoApply: false,
  autoRent: false,
  autoCancelOnFail: false,
  network: 'devnet',
  genesisHash: DEVNET_GENESIS,
  rpcUrl: 'wss://rpc.devnet.flop.network',
  limitsUrl: 'https://faucet.flop.network/limits',
  sponsorUrl: 'https://faucet.flop.network/sponsor/miner',
  sponsorMode: 'automatic',
  signMode: 'local',
  sponsorSh: '',
  pollMinMs: 30_000,
  pollMaxMs: 60_000,
  allowFastPoll: false,
  seatTtlMs: 10 * 60 * 1000,
  addressFile: '',
  signerFile: '',
  modelProfile: '8b',
  profiles: {
    '8b': { minVramGb: 16 },
    '27b': { minVramGb: 80, minDiskGb: 200 },
  },
  clore: {
    baseUrl: 'https://api.clore.ai/v1',
    image: '',
    currency: 'CLORE-Blockchain',
    type: 'on-demand',
    rentalHours: null,
    autoRenew: false,
    autoRenewMaxPrice: null,
  },
  review: {
    submitUrl: '',
    approvedFile: '',
  },
  maxSponsorRetries: 2,
  retry503Ms: 60_000,
  stateDir: 'flop-sponsor/data',
  // LIVE 没填 maxUsdPerHour 会拒绝启动。价格按 USD-Blockchain 日价 / 24。
  maxUsdPerHour: null,
  // LIVE 没填则拒绝，避免 on-demand 没有租期上限。
  maxRentHours: null,
  // hourly：每小时总价；h100：每小时总价 / (显存 GB / 80)
  rankBy: 'hourly',
  graceHoursDefault: 4,
  bootEstimateMs: 15 * 60 * 1000,
  calibrateEstimateMs: 30 * 60 * 1000,
  reconcileBudgetMs: 3 * 60 * 1000,
};

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = merge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig(file) {
  let extra = {};
  if (file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { throw new Stop(`读不到配置文件：${file}`); }
    try { extra = JSON.parse(raw); }
    catch { throw new Stop('配置文件不是 JSON'); }
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Stop('配置文件必须是对象');
  }
  const cfg = merge(structuredClone(DEFAULTS), extra);
  if (cfg.sponsorMode !== 'automatic' && cfg.sponsorMode !== 'review') {
    throw new Stop('sponsorMode 只能是 automatic 或 review');
  }
  if (cfg.signMode !== 'local' && cfg.signMode !== 'sponsor-sh') {
    throw new Stop('signMode 只能是 local 或 sponsor-sh');
  }
  if (cfg.clore?.type && cfg.clore.type !== 'on-demand') {
    throw new Stop('FLOP 这条路径只用 Clore on-demand，不用 spot');
  }
  if (cfg.clore?.autoRenew === true && !(Number(cfg.clore.autoRenewMaxPrice) > 0)) {
    throw new Stop('autoRenew=true 时必须自己填写 autoRenewMaxPrice，脚本不猜价格');
  }
  if (!cfg.profiles?.[cfg.modelProfile]) throw new Stop(`未知机型档位：${cfg.modelProfile}`);
  if (cfg.rankBy !== 'hourly' && cfg.rankBy !== 'h100') throw new Stop('rankBy 只能是 hourly 或 h100');
  return cfg;
}

// 写入口专用。dryRun 或双开关缺一就抛错，不能靠调用方记得提前返回。
export function assertLive(cfg, env = process.env) {
  if (executionMode(cfg, env) !== 'live') {
    throw new Stop('写操作被拒绝：需要 dryRun=false、autoApply=true、autoRent=true，并且 FLOP_CONFIRM_LIVE=1', 'LIVE_REFUSED');
  }
}

export function assertLiveReady(cfg) {
  if (!(Number(cfg.maxUsdPerHour) > 0)) throw new Stop('LIVE 必须配置 maxUsdPerHour，拒绝不限价启动');
  if (!(Number(cfg.maxRentHours) > 0)) throw new Stop('LIVE 必须配置 maxRentHours，拒绝没有租期上限的 on-demand');
}

// dryRun 不是 false 时永远只读。想写远端必须三个条件同时成立。
export function executionMode(cfg, env = process.env) {
  if (cfg.dryRun !== false) return 'dry';
  if (cfg.autoApply === true && cfg.autoRent === true && env.FLOP_CONFIRM_LIVE === '1') return 'live';
  throw new Stop('已拒绝写操作：需要 dryRun=false、autoApply=true、autoRent=true，并且环境变量 FLOP_CONFIRM_LIVE=1', 'LIVE_REFUSED');
}
