// 配置迁移：旧文件里没改过的默认值升级，用户改过的值保持不变。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = process.argv[2];
process.chdir(dir);
fs.rmSync('data', { recursive: true, force: true });
fs.mkdirSync('data');
const U = p => pathToFileURL(path.join(dir, p)).href;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

fs.writeFileSync('data/config.json', JSON.stringify({
  configVersion: 1,
  minInetDown: 20,
  scanIntervalSec: 180,
  scanRows: 100,
  stopLossPct: 0,
  stopLossMinutes: 30,
  bootTimeoutMinutes: 20,
  minerStartTimeoutMinutes: 8,
  targetProfitPct: 25,
  maxHourlySpend: 0.4,
}));
let S = await import(U('src/store.js'));
let c = S.loadConfig();
ok(c.configVersion === 3, '旧配置版本升到 3');
ok(c.minInetDown === 200 && c.scanIntervalSec === 600 && c.scanRows === 20, `没改过的扫描默认值升级（间隔 ${c.scanIntervalSec}s，条数 ${c.scanRows}，带宽 ${c.minInetDown}）`);
ok(c.stopLossPct === 12 && c.stopLossMinutes === 12 && c.bootTimeoutMinutes === 12 && c.minerStartTimeoutMinutes === 10, '没改过的止损/部署默认值升级成利润底线和更短超时');
ok(c.targetProfitPct === 25 && c.maxHourlySpend === 0.4, '用户改过的目标收益率和预算保持不变');
ok(c.rentMode === 'interruptible' && c.autoRent === false && c.bidUpliftPct === 3, '新字段使用默认可中断、自动租用仍关闭、上浮 3%');

fs.writeFileSync('data/config.json', JSON.stringify({
  configVersion: 2,
  stopLossPct: -10,
  stopLossMinutes: 45,
  scanIntervalSec: 90,
  scanRows: 40,
  bootTimeoutMinutes: 18,
  minerStartTimeoutMinutes: 9,
  rentMode: 'ondemand',
}));
S = await import(U('src/store.js') + '?v=2');
c = S.loadConfig();
ok(c.stopLossPct === -10 && c.stopLossMinutes === 45 && c.scanIntervalSec === 90 && c.scanRows === 40, '已经偏离旧默认值的项不跟着升级');
ok(c.bootTimeoutMinutes === 18 && c.minerStartTimeoutMinutes === 9 && c.rentMode === 'ondemand', '用户显式选择的按需模式和自定义超时保留');
ok(c.autoRent === false, '迁移不会把自动租用打开');

const Econ = await import(U('src/economics.js'));
const keys = Econ.viableModelKeys([
  { key: 'RTX4070S', effective: 122, autoOk: true },
  { key: 'RTX4070TI', effective: 124, autoOk: true },
  { key: 'RTX5090', effective: 370, autoOk: true },
  { key: 'RTX3060', effective: 41, autoOk: true },
  { key: 'H100SXM', effective: 650, autoOk: false },
], 2e-15, 30, 0.04);
ok(keys.includes('RTX4070S') && keys.includes('RTX4070TI') && keys.includes('RTX5090') && keys.includes('RTX3060') && !keys.includes('H100SXM'), `达标型号包含 3060/4070S/4070Ti/5090，不含只有估算算力的 H100（${keys.join(',')}）`);

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
