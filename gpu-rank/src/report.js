import { explain } from './reasons.js';

const OPS_LABELS = {
  migrationDownload: '迁移下载',
  overlapRent: '重叠租金',
  drain: '排空任务',
  stability: '稳定性',
  leaseCooldown: '租约/冷却',
};

export function reportText(report) {
  const lines = [];
  lines.push(report.dataset?.kind === 'example'
    ? 'EXAMPLE DATA — 不是真实市场排名，不能用来租机。'
    : '导入或市场快照 — 缺同条件实测的报价不排名。');
  lines.push('没有筛出最优机器。optimalMachineSelected=false。');
  lines.push(`数据集 ${report.dataset?.id || ''}  采集 ${report.dataset?.collectedAt || ''}  asOf ${report.asOf}`);
  lines.push('等效H100 = 候选整机实测吞吐 / 同一模型、revision、精度、输入输出长度、batch、并发、指标和延迟约束下的指定 H100 基准吞吐。');
  lines.push('USD每等效H100小时 = 整机全包USD/h / 等效H100。组内按该值升序。没有预置 GPU→H100 系数。跨组不混排。');
  lines.push(report.disclaimer || '');
  if (!report.groups?.length) lines.push('实测可比组：无。');
  for (const [i, group] of (report.groups || []).entries()) {
    const b = group.baseline;
    lines.push(`可比组 ${i + 1}: baseline ${b.id} ${b.formFactor} ${b.vramGb}GB ${b.memoryGeneration}；本组 ${group.rows.length} 条，只在组内排序。`);
    for (const row of group.rows) {
      lines.push(`  ${row.rank}. ${row.offerId}  USD/等效H100小时=${fmt(row.usdPerEqH100Hour)}  等效H100=${fmt(row.eqH100)}  全包USD/h=${fmt(row.allInUsdPerHour)}  支付=${row.paymentCurrency}  采集=${row.collectedAt}`);
    }
  }
  if (report.theoreticalBoards?.length) {
    lines.push('理论代理榜（单独标记，不是实测排名，不与实测组混排）：');
    for (const group of report.theoreticalBoards) {
      for (const row of group.rows) {
        lines.push(`  理论 ${row.rank}. ${row.offerId}  USD/等效H100小时=${fmt(row.usdPerEqH100Hour)}  采集=${row.collectedAt}`);
      }
    }
  }
  lines.push(`排除 ${report.excluded?.length || 0}，待核 ${report.pending?.length || 0}，拒绝 ${report.rejected?.length || 0}。`);
  for (const row of [...(report.excluded || []), ...(report.pending || []), ...(report.rejected || [])]) {
    const why = (row.allReasons || row.reasons || []).map(r => `${r.code} ${explain(r.code)}`).join('；');
    lines.push(`- ${row.status} ${row.offerId || '(no id)'} 采集 ${row.collectedAt || ''}：${why}`);
  }
  lines.push('运维项不进入价格，也不折算收益：');
  for (const row of report.ranked || []) lines.push(`  ${row.offerId} ${opsText(row.ops)}`);
  for (const row of report.pending || []) lines.push(`  ${row.offerId} ${opsText(row.ops)}`);
  lines.push('缺口：');
  for (const gap of report.gaps || []) lines.push(`- ${gap}`);
  return lines.join('\n') + '\n';
}

function opsText(ops) {
  if (!ops) return '运维项缺失';
  return Object.entries(OPS_LABELS).map(([key, label]) => {
    const item = ops[key] || { status: 'unknown' };
    const hours = item.status === 'known' && item.hours != null ? ` ${item.hours}h` : '';
    return `${label}=${item.status}${hours}`;
  }).join('，');
}

function fmt(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  return String(n);
}

const CSV_COLUMNS = [
  'status', 'board', 'groupKey', 'rank', 'offerId', 'marketplace', 'collectedAt', 'expiresAt',
  'quoteCurrency', 'paymentCurrency', 'priceUnit', 'period', 'rawAmount', 'allInUsdPerHour',
  'throughput', 'throughputScope', 'gpuCount', 'gpuModel', 'baselineId', 'eqH100', 'usdPerEqH100Hour',
  'reasons', 'opsMigration', 'opsOverlap', 'opsDrain', 'opsStability', 'opsLease', 'sourceUrl',
];

export function reportCsv(report) {
  const lines = [CSV_COLUMNS.join(',')];
  const groupOf = new Map();
  for (const group of report.groups || []) {
    for (const row of group.rows) groupOf.set(`measured:${row.offerId}`, group.groupKey);
  }
  for (const group of report.theoreticalBoards || []) {
    for (const row of group.rows) groupOf.set(`theoretical:${row.offerId}`, group.groupKey);
  }
  const rankedIds = new Set((report.ranked || []).map(r => r.offerId));
  const theoreticalRows = (report.theoreticalBoards || []).flatMap(g => g.rows.map(row => ({ ...row, status: 'theoretical' })));
  const rest = [...(report.pending || []), ...(report.excluded || []), ...(report.rejected || [])]
    .filter(row => !row.theoretical);
  for (const row of [...(report.ranked || []), ...theoreticalRows, ...rest]) {
    if (row.status === 'ranked' && !rankedIds.has(row.offerId)) continue;
    const key = `${row.board || (row.status === 'ranked' ? 'measured' : row.status)}:${row.offerId}`;
    lines.push(CSV_COLUMNS.map(col => csvCell(csvValue(col, row, groupOf.get(key) || ''))).join(','));
  }
  return lines.join('\n') + '\n';
}

function csvValue(col, row, groupKey) {
  const ops = row.ops || {};
  switch (col) {
    case 'groupKey': return groupKey;
    case 'reasons': return (row.allReasons || row.reasons || []).map(r => r.code).join('|');
    case 'opsMigration': return ops.migrationDownload?.status || '';
    case 'opsOverlap': return ops.overlapRent?.status || '';
    case 'opsDrain': return ops.drain?.status || '';
    case 'opsStability': return ops.stability?.status || '';
    case 'opsLease': return ops.leaseCooldown?.status || '';
    default: return row[col];
  }
}

function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}
