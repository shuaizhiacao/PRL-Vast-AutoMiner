import { quoteAllIn } from './money.js';
import {
  OPS_KEYS, assessBaseline, finite, httpsUrl, isIsoZ, sameWorkload, validateStructure,
} from './schema.js';

const KNOWN_OFFER_KEYS = new Set([
  'id', 'marketplace', 'sourceUrl', 'collectedAt', 'expiresAt', 'available', 'availabilityEvidence',
  'gpu', 'diskGb', 'diskEvidence', 'network', 'backend', 'quote', 'benchmarks', 'ops',
]);

export function rankDocument(doc, { includeTheoretical = false, inputSha256 = null } = {}) {
  const structural = validateStructure(doc);
  if (!structural.ok) return { ok: false, errors: structural.errors };
  const asOfMs = Date.parse(doc.asOf);
  const baselines = (doc.baselines || []).map(b => ({
    baseline: b,
    problems: assessBaseline(b, doc.workload, asOfMs),
  }));
  const usable = new Map(baselines.filter(b => b.problems.length === 0).map(b => [b.baseline.id, b.baseline]));
  const idCount = new Map();
  for (const offer of doc.offers) {
    const id = offer && offer.id != null ? String(offer.id) : '';
    idCount.set(id, (idCount.get(id) || 0) + 1);
  }
  const classified = doc.offers.map((offer, index) => classifyOffer(offer, index, {
    doc, asOfMs, usable, idCount, includeTheoretical,
  }));
  const groups = groupRows(classified.filter(row => row.status === 'ranked'), doc.workload);
  const theoreticalBoards = includeTheoretical
    ? groupRows(classified.filter(row => row.theoretical), doc.workload)
    : [];
  const report = {
    ok: true,
    schemaVersion: 'gpu-rank.report.v1',
    generatedFrom: 'gpu-rank',
    inputSha256,
    asOf: doc.asOf,
    dataset: doc.dataset,
    optimalMachineSelected: false,
    rankedIsMarketOptimum: false,
    disclaimer: disclaimer(doc),
    workload: {
      modelId: doc.workload.modelId,
      revision: doc.workload.revision,
      precision: doc.workload.precision,
      inputTokens: doc.workload.inputTokens,
      outputTokens: doc.workload.outputTokens,
      batchSize: doc.workload.batchSize,
      concurrency: doc.workload.concurrency,
      maxLatencyMs: doc.workload.maxLatencyMs,
      metric: doc.workload.metric,
    },
    formula: {
      eqH100: 'candidate whole-machine measured throughput / same-condition H100 baseline throughput',
      usdPerEqH100Hour: 'whole-machine all-in USD per hour / eqH100',
      coefficients: 'none',
      crossBenchmarkMixing: false,
    },
    groups,
    theoreticalBoards,
    ranked: groups.flatMap(g => g.rows),
    pending: classified.filter(r => r.status === 'pending'),
    excluded: classified.filter(r => r.status === 'excluded'),
    rejected: classified.filter(r => r.status === 'rejected'),
    invalidBaselines: baselines.filter(b => b.problems.length).map(b => ({
      id: b.baseline?.id ?? null,
      problems: b.problems,
    })),
    gaps: [],
  };
  report.gaps = buildGaps(report);
  return report;
}

function disclaimer(doc) {
  const example = doc.dataset.kind === 'example'
    ? 'EXAMPLE DATA. This is not a live market ranking and must not be used to rent.'
    : 'Market snapshot or imported quotes. Missing same-condition measurements stay unranked.';
  return `${example} No order is sent. optimalMachineSelected is always false. Unknown fees, FX, billing units, and hard gates are not treated as zero or as a pass.`;
}

function classifyOffer(offer, index, ctx) {
  const reasons = [];
  const add = (bucket, code, detail) => reasons.push({ bucket, code, detail: detail || '' });
  const id = offer && offer.id != null ? String(offer.id) : '';
  if (!offer || typeof offer !== 'object') {
    add('rejected', 'missing_id', `index ${index}`);
    return finish(id, index, offer, reasons, null);
  }
  if (!id) add('rejected', 'missing_id');
  else if ((ctx.idCount.get(id) || 0) > 1) add('rejected', 'duplicate_id');
  if (typeof offer.marketplace !== 'string' || !offer.marketplace.trim()) add('rejected', 'marketplace_missing');
  if (!httpsUrl(offer.sourceUrl)) add('rejected', 'source_url_missing');
  if (!isIsoZ(offer.collectedAt) || !isIsoZ(offer.expiresAt)) add('rejected', 'invalid_timestamp');
  else {
    const collected = Date.parse(offer.collectedAt);
    const expires = Date.parse(offer.expiresAt);
    if (collected > ctx.asOfMs) add('rejected', 'collected_in_future');
    if (expires <= ctx.asOfMs) add('rejected', 'expired');
    if (ctx.doc.maxAgeSeconds != null && ctx.asOfMs - collected > ctx.doc.maxAgeSeconds * 1000) add('rejected', 'expired', 'maxAgeSeconds');
  }
  const ignoredOfferKeys = Object.keys(offer).filter(k => !KNOWN_OFFER_KEYS.has(k));
  gateHardware(offer, ctx.doc.requirements, add);
  checkOps(offer.ops, add);
  const money = quoteAllIn(offer.quote, { fx: ctx.doc.fx, asOfMs: ctx.asOfMs });
  for (const code of dedupe(money.rejected)) add('rejected', code);
  for (const code of dedupe(money.pending)) add('pending', code);
  const bench = matchBenchmark(offer, ctx);
  for (const code of bench.rejected) add('rejected', code);
  for (const code of bench.excluded || []) add('excluded', code);
  for (const code of bench.pending) add('pending', code);
  const status = pickStatus(reasons);
  const theoretical = ctx.includeTheoretical && bench.theoretical && status !== 'rejected' && status !== 'excluded'
    && !reasons.some(r => r.bucket === 'pending' && r.code !== 'theoretical_not_in_measured_board');
  return finish(id, index, offer, reasons, {
    status,
    money: money.ok ? money.allInUsdPerHour : null,
    bench,
    theoretical,
    ignoredOfferKeys,
    notes: money.notes,
  });
}

function finish(id, index, offer, reasons, extra) {
  const status = extra?.status || pickStatus(reasons);
  const measured = extra?.bench?.measured || null;
  const baseline = measured?.baseline || extra?.bench?.theoretical?.baseline || null;
  const throughput = measured?.throughput ?? extra?.bench?.theoretical?.throughput ?? null;
  const allIn = status === 'ranked' || extra?.theoretical ? extra?.money : null;
  let eqH100 = null;
  let usdPerEqH100Hour = null;
  if ((status === 'ranked' || extra?.theoretical) && throughput != null && baseline && allIn != null) {
    eqH100 = throughput / baseline.throughput;
    usdPerEqH100Hour = allIn / eqH100;
    if (!(eqH100 > 0) || !Number.isFinite(eqH100) || !Number.isFinite(usdPerEqH100Hour)) {
      eqH100 = null;
      usdPerEqH100Hour = null;
    }
  }
  const row = {
    status: extra?.theoretical && status !== 'ranked' ? 'theoretical' : status,
    index,
    offerId: id,
    marketplace: offer?.marketplace ?? null,
    collectedAt: offer?.collectedAt ?? null,
    expiresAt: offer?.expiresAt ?? null,
    sourceUrl: offer?.sourceUrl ?? null,
    quoteCurrency: offer?.quote?.quoteCurrency ?? null,
    paymentCurrency: offer?.quote?.paymentCurrency ?? null,
    priceUnit: offer?.quote?.priceUnit ?? null,
    period: offer?.quote?.period ?? null,
    rawAmount: finite(offer?.quote?.amount),
    allInUsdPerHour: status === 'ranked' || extra?.theoretical ? allIn : null,
    throughput: status === 'ranked' || extra?.theoretical ? throughput : null,
    throughputScope: status === 'ranked' || extra?.theoretical ? 'whole_machine' : null,
    gpuCount: Number.isInteger(offer?.gpu?.count) ? offer.gpu.count : null,
    gpuModel: offer?.gpu?.model ?? null,
    baselineId: status === 'ranked' || extra?.theoretical ? baseline?.id ?? null : null,
    baselineFormFactor: baseline && (status === 'ranked' || extra?.theoretical) ? baseline.gpu.formFactor : null,
    baselineVramGb: baseline && (status === 'ranked' || extra?.theoretical) ? baseline.gpu.vramGb : null,
    baselineMemoryGeneration: baseline && (status === 'ranked' || extra?.theoretical) ? baseline.gpu.memoryGeneration : null,
    eqH100: status === 'ranked' || extra?.theoretical ? eqH100 : null,
    usdPerEqH100Hour: status === 'ranked' || extra?.theoretical ? usdPerEqH100Hour : null,
    ops: snapshotOps(offer?.ops),
    reasons: reasons.filter(r => r.bucket === statusBucket(status, extra)).map(r => ({ code: r.code, detail: r.detail })),
    allReasons: reasons.map(r => ({ bucket: r.bucket, code: r.code, detail: r.detail })),
    ignoredOfferKeys: extra?.ignoredOfferKeys || [],
    notes: extra?.notes || [],
    board: extra?.theoretical && status !== 'ranked' ? 'theoretical' : (status === 'ranked' ? 'measured' : null),
  };
  if (extra?.theoretical && status !== 'ranked') row.theoretical = true;
  else row.theoretical = false;
  if (status === 'ranked') row.status = 'ranked';
  return row;
}

function statusBucket(status, extra) {
  if (extra?.theoretical && status !== 'ranked') return 'pending';
  return status === 'theoretical' ? 'pending' : status;
}

function pickStatus(reasons) {
  if (reasons.some(r => r.bucket === 'rejected')) return 'rejected';
  if (reasons.some(r => r.bucket === 'excluded')) return 'excluded';
  if (reasons.some(r => r.bucket === 'pending')) return 'pending';
  return 'ranked';
}

function dedupe(list) {
  return [...new Set(list)];
}

function gateHardware(offer, req, add) {
  if (offer.available === false) add('excluded', 'unavailable');
  else if (offer.available !== true) add('pending', 'availability_unknown');
  else if (typeof offer.availabilityEvidence !== 'string' || !offer.availabilityEvidence.trim()) add('pending', 'availability_evidence_missing');

  const gpu = offer.gpu || {};
  if (gpu.count == null) add('pending', 'gpu_count_unknown');
  else if (!Number.isInteger(gpu.count) || gpu.count < 1) add('rejected', 'gpu_count_invalid');
  if (typeof gpu.model !== 'string' || !gpu.model.trim()) add('pending', 'gpu_model_unknown');

  applyVram(req.vram, gpu, add);
  applyBackend(req.backend, offer.backend, add);
  applyNetwork(req.network, offer.network, add);
  applyDisk(req.disk, offer, add);
}

function applyVram(req, gpu, add) {
  if (req.mode === 'disabled') return;
  if (gpu.vramScope && gpu.vramScope !== 'per_gpu') {
    add('pending', 'vram_scope_unknown');
    return;
  }
  const vram = finite(gpu.vramGbEach);
  if (vram == null) {
    add('pending', 'vram_unknown');
    return;
  }
  if (typeof gpu.vramEvidence !== 'string' || !gpu.vramEvidence.trim()) {
    add('pending', 'vram_evidence_missing');
    return;
  }
  if (vram < req.minGb) add('excluded', 'vram_below_minimum', `${vram} < ${req.minGb}`);
}

function applyBackend(req, backend, add) {
  if (req.mode === 'disabled') return;
  if (!backend || backend.compatible == null) {
    add('pending', 'backend_unknown');
    return;
  }
  if (backend.compatible === false) {
    add('excluded', 'backend_incompatible');
    return;
  }
  if (backend.compatible !== true) {
    add('pending', 'backend_unknown');
    return;
  }
  if (typeof backend.evidence !== 'string' || !backend.evidence.trim()) {
    add('pending', 'backend_evidence_missing');
    return;
  }
  if (!req.names.includes(backend.name)) add('excluded', 'backend_not_allowed', String(backend.name));
}

function applyNetwork(req, network, add) {
  if (req.mode === 'disabled') return;
  const down = finite(network?.downMbps);
  const up = finite(network?.upMbps);
  if (down == null || up == null) {
    add('pending', 'network_unknown');
    return;
  }
  if (typeof network?.evidence !== 'string' || !network.evidence.trim()) {
    add('pending', 'network_evidence_missing');
    return;
  }
  if (down < req.downMbps || up < req.upMbps) add('excluded', 'network_below_minimum', `down ${down} up ${up}`);
}

function applyDisk(req, offer, add) {
  if (req.mode === 'disabled') return;
  const disk = finite(offer.diskGb);
  if (disk == null) {
    add('pending', 'disk_unknown');
    return;
  }
  if (typeof offer.diskEvidence !== 'string' || !offer.diskEvidence.trim()) {
    add('pending', 'disk_evidence_missing');
    return;
  }
  if (disk < req.minGb) add('excluded', 'disk_below_minimum', `${disk} < ${req.minGb}`);
}

function checkOps(ops, add) {
  if (!ops || typeof ops !== 'object') {
    add('pending', 'ops_undeclared');
    return;
  }
  for (const key of OPS_KEYS) {
    const item = ops[key];
    if (!item || typeof item !== 'object') {
      add('pending', 'ops_undeclared', key);
      continue;
    }
    if (item.status !== 'known' && item.status !== 'unknown') {
      add('pending', 'ops_invalid', key);
      continue;
    }
    const hasHours = item.hours != null;
    if (item.status === 'unknown' && hasHours) add('pending', 'ops_unknown_has_value', key);
    if (item.status === 'known' && (typeof item.note !== 'string' || !item.note.trim())) add('pending', 'ops_known_note_missing', key);
    if (hasHours && !(finite(item.hours) >= 0)) add('pending', 'ops_invalid', key);
  }
}

function snapshotOps(ops) {
  const out = {};
  for (const key of OPS_KEYS) {
    const item = ops?.[key];
    out[key] = item && typeof item === 'object'
      ? { status: item.status || 'unknown', note: item.note || '', hours: item.status === 'known' ? finite(item.hours) : null }
      : { status: 'unknown', note: '', hours: null };
  }
  return out;
}

function matchBenchmark(offer, ctx) {
  const pending = [];
  const rejected = [];
  const excluded = [];
  const benches = Array.isArray(offer.benchmarks) ? offer.benchmarks : null;
  if (!benches || !benches.length) {
    pending.push('missing_comparable_benchmark');
    return { pending, rejected, excluded, measured: null, theoretical: null };
  }
  const same = [];
  let otherWorkload = false;
  for (const bench of benches) {
    if (!bench || typeof bench !== 'object') {
      pending.push('benchmark_kind_unknown');
      continue;
    }
    if (bench.kind !== 'measured' && bench.kind !== 'theoretical') {
      pending.push('benchmark_kind_unknown');
      continue;
    }
    if (!sameWorkload(bench.workload, ctx.doc.workload) || bench.metric !== ctx.doc.workload.metric) {
      otherWorkload = true;
      continue;
    }
    if (!(finite(bench.throughput) > 0)) {
      rejected.push('invalid_throughput');
      continue;
    }
    same.push(bench);
  }
  if (rejected.length) return { pending, rejected, excluded, measured: null, theoretical: null };
  const fitted = [];
  for (const bench of same) {
    const fit = benchmarkFits(bench, offer, ctx);
    if (!fit.ok) {
      if (fit.code === 'latency_over_constraint') excluded.push(fit.code);
      else pending.push(fit.code);
      continue;
    }
    fitted.push(fit);
  }
  const measured = fitted.filter(fit => fit.bench.kind === 'measured');
  const theoretical = fitted.filter(fit => fit.bench.kind === 'theoretical');
  if (measured.length > 1) pending.push('benchmark_ambiguous');
  if (measured.length === 1 && !pending.length && !excluded.length) {
    return { pending, rejected, excluded, measured: measured[0], theoretical: null };
  }
  if (measured.length === 1 && (pending.length || excluded.length)) pending.push('benchmark_ambiguous');
  if (!measured.length) {
    if (theoretical.length === 1 && !pending.length && !excluded.length) {
      const theo = theoretical[0];
      if (!httpsUrl(theo.bench.citationUrl) || typeof theo.bench.citationQuote !== 'string' || !theo.bench.citationQuote.trim()) {
        pending.push('theoretical_citation_missing');
      } else pending.push('theoretical_not_in_measured_board');
      return {
        pending: dedupe(pending), rejected, excluded,
        measured: null,
        theoretical: pending.includes('theoretical_citation_missing') ? null : theo,
      };
    }
    if (theoretical.length > 1) pending.push('benchmark_ambiguous');
    else if (!pending.length && !excluded.length && otherWorkload) pending.push('benchmark_not_comparable');
    else if (!pending.length && !excluded.length) pending.push('missing_comparable_benchmark');
  }
  return { pending: dedupe(pending), rejected, excluded, measured: null, theoretical: null };
}

function benchmarkFits(bench, offer, ctx) {
  if (!sameWorkload(bench.workload, ctx.doc.workload) || bench.metric !== ctx.doc.workload.metric) {
    return { ok: false, comparable: false };
  }
  if (bench.latencyMs == null) return { ok: false, code: 'latency_unknown' };
  if (!(finite(bench.latencyMs) >= 0)) return { ok: false, code: 'latency_unknown' };
  if (bench.latencyMs > ctx.doc.workload.maxLatencyMs) return { ok: false, code: 'latency_over_constraint' };
  if (bench.throughputScope !== 'whole_machine') return { ok: false, code: 'throughput_scope_not_whole_machine' };
  if (!Number.isInteger(offer.gpu?.count) || bench.gpuCountAtMeasurement !== offer.gpu.count) {
    return { ok: false, code: 'gpu_count_measurement_mismatch' };
  }
  if (!httpsUrl(bench.sourceUrl) || !isIsoZ(bench.collectedAt)) return { ok: false, code: 'benchmark_provenance_missing' };
  if (Date.parse(bench.collectedAt) > ctx.asOfMs) return { ok: false, code: 'benchmark_collected_in_future' };
  const baseline = ctx.usable.get(bench.baselineId);
  if (!baseline) return { ok: false, code: 'baseline_missing' };
  if (!sameWorkload(baseline.workload, bench.workload) || baseline.metric !== bench.metric) {
    return { ok: false, code: 'baseline_not_comparable' };
  }
  return { ok: true, bench, baseline, throughput: bench.throughput };
}

function groupRows(rows, workload) {
  const map = new Map();
  for (const row of rows) {
    if (!(row.usdPerEqH100Hour > 0) || !Number.isFinite(row.usdPerEqH100Hour)) continue;
    const key = JSON.stringify({
      modelId: workload.modelId,
      revision: workload.revision,
      precision: workload.precision,
      inputTokens: workload.inputTokens,
      outputTokens: workload.outputTokens,
      batchSize: workload.batchSize,
      concurrency: workload.concurrency,
      metric: workload.metric,
      maxLatencyMs: workload.maxLatencyMs,
      baselineId: row.baselineId,
      baselineFormFactor: row.baselineFormFactor,
      baselineVramGb: row.baselineVramGb,
      baselineMemoryGeneration: row.baselineMemoryGeneration,
    });
    if (!map.has(key)) {
      map.set(key, {
        groupKey: key,
        comparable: true,
        mixAcrossBenchmarks: false,
        order: 'usdPerEqH100Hour ascending',
        workload: {
          modelId: workload.modelId,
          revision: workload.revision,
          precision: workload.precision,
          inputTokens: workload.inputTokens,
          outputTokens: workload.outputTokens,
          batchSize: workload.batchSize,
          concurrency: workload.concurrency,
          metric: workload.metric,
          maxLatencyMs: workload.maxLatencyMs,
        },
        baseline: {
          id: row.baselineId,
          formFactor: row.baselineFormFactor,
          vramGb: row.baselineVramGb,
          memoryGeneration: row.baselineMemoryGeneration,
        },
        rows: [],
      });
    }
    map.get(key).rows.push(publicRow(row));
  }
  const groups = [...map.values()];
  for (const group of groups) {
    group.rows.sort((a, b) => a.usdPerEqH100Hour - b.usdPerEqH100Hour || String(a.offerId).localeCompare(String(b.offerId)));
    group.rows.forEach((row, i) => { row.rank = i + 1; });
  }
  groups.sort((a, b) => a.groupKey.localeCompare(b.groupKey));
  return groups;
}

function publicRow(row) {
  return {
    rank: null,
    status: row.status,
    board: row.board,
    offerId: row.offerId,
    marketplace: row.marketplace,
    collectedAt: row.collectedAt,
    expiresAt: row.expiresAt,
    sourceUrl: row.sourceUrl,
    quoteCurrency: row.quoteCurrency,
    paymentCurrency: row.paymentCurrency,
    priceUnit: row.priceUnit,
    period: row.period,
    allInUsdPerHour: row.allInUsdPerHour,
    throughput: row.throughput,
    throughputScope: row.throughputScope,
    gpuCount: row.gpuCount,
    gpuModel: row.gpuModel,
    baselineId: row.baselineId,
    baselineFormFactor: row.baselineFormFactor,
    baselineVramGb: row.baselineVramGb,
    baselineMemoryGeneration: row.baselineMemoryGeneration,
    eqH100: row.eqH100,
    usdPerEqH100Hour: row.usdPerEqH100Hour,
    ops: row.ops,
    board: row.board,
  };
}

function buildGaps(report) {
  const gaps = [];
  if (report.dataset.kind === 'example') gaps.push('dataset is EXAMPLE and is not a real ranking');
  if (!report.groups.length) gaps.push('no measured comparable group was ranked');
  if (report.pending.length) gaps.push(`${report.pending.length} offer(s) pending and not ranked`);
  if (report.excluded.length) gaps.push(`${report.excluded.length} offer(s) excluded by a known hard gate`);
  if (report.rejected.length) gaps.push(`${report.rejected.length} offer(s) rejected by validation`);
  if (report.invalidBaselines.length) gaps.push('one or more H100 baselines failed validation and were not used');
  const codes = new Map();
  for (const row of [...report.pending, ...report.excluded, ...report.rejected]) {
    for (const reason of row.allReasons || []) codes.set(reason.code, (codes.get(reason.code) || 0) + 1);
  }
  for (const [code, n] of [...codes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    gaps.push(`${code}: ${n}`);
  }
  gaps.push('migration, overlap rent, drain, stability, and lease/cooldown are reported only and are not monetized');
  gaps.push('no yield, airdrop, or profit is estimated');
  return gaps;
}
