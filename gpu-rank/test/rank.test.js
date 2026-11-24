import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { rankDocument } from '../src/rank.js';
import { reportCsv, reportText } from '../src/report.js';
import { AS_OF, comparableDocument, edgesDocument, offer, workload } from '../fixtures/factory.js';

test('committed EXAMPLE files match the factory and stay labeled as examples', () => {
  const comparable = JSON.parse(readFileSync(new URL('../fixtures/EXAMPLE.comparable.json', import.meta.url), 'utf8'));
  const edges = JSON.parse(readFileSync(new URL('../fixtures/EXAMPLE.edges.json', import.meta.url), 'utf8'));
  assert.deepEqual(comparable, comparableDocument());
  assert.deepEqual(edges, edgesDocument());
  assert.match(comparable.dataset.label, /EXAMPLE/);
  assert.match(edges.dataset.label, /EXAMPLE/);
});

test('example comparable fixture ranks inside baseline groups and does not declare a winner', () => {
  const report = rankDocument(comparableDocument());
  assert.equal(report.ok, true);
  assert.equal(report.optimalMachineSelected, false);
  assert.equal(report.rankedIsMarketOptimum, false);
  assert.equal(report.groups.length, 2);
  const sxm = report.groups.find(g => g.baseline.id === 'h100-sxm-80-hbm3');
  const pcie = report.groups.find(g => g.baseline.id === 'h100-pcie-80-hbm2e');
  assert.deepEqual(sxm.rows.map(r => r.offerId), ['ex-clore', 'ex-a', 'ex-b']);
  assert.equal(sxm.rows[0].allInUsdPerHour, 1);
  assert.equal(sxm.rows[0].eqH100, 1);
  assert.equal(sxm.rows[0].usdPerEqH100Hour, 1);
  assert.equal(sxm.rows[1].allInUsdPerHour, 2.5);
  assert.equal(sxm.rows[1].eqH100, 0.8);
  assert.equal(sxm.rows[1].usdPerEqH100Hour, 3.125);
  assert.equal(sxm.rows[2].usdPerEqH100Hour, 4);
  assert.ok(sxm.rows[2].allInUsdPerHour < sxm.rows[1].allInUsdPerHour);
  assert.equal(pcie.rows.length, 1);
  assert.equal(pcie.rows[0].offerId, 'ex-pcie');
  assert.equal(pcie.rows[0].usdPerEqH100Hour, 8);
  const text = reportText(report);
  assert.match(text, /EXAMPLE DATA/);
  assert.match(text, /没有筛出最优机器/);
  assert.equal(report.groups.some(g => g.rows.some(r => r.baselineId !== g.baseline.id)), false);
});

test('edge fixture rejects bad throughput, blocks invented CLORE conversion, and keeps hard gates', () => {
  const report = rankDocument(edgesDocument());
  assert.equal(report.optimalMachineSelected, false);
  assert.equal(report.groups.length, 0);
  const byId = Object.fromEntries([...report.pending, ...report.excluded, ...report.rejected].map(r => [r.offerId, r]));
  assert.equal(byId['ex-per-gpu'].status, 'pending');
  assert.equal(byId['ex-per-gpu'].allInUsdPerHour, null);
  assert.ok(byId['ex-per-gpu'].allReasons.some(r => r.code === 'price_unit_per_gpu'));
  assert.equal(byId['ex-unknown-fee'].allInUsdPerHour, null);
  assert.ok(byId['ex-unknown-fee'].allReasons.some(r => r.code === 'fee_schedule_incomplete' || r.code === 'component_unknown'));
  assert.equal(byId['ex-expired'].status, 'rejected');
  assert.ok(byId['ex-expired'].allReasons.some(r => r.code === 'vendor_expired'));
  assert.equal(byId['ex-dup'].status, 'rejected');
  assert.ok(byId['ex-dup'].allReasons.some(r => r.code === 'duplicate_id'));
  assert.equal(report.rejected.filter(r => r.offerId === 'ex-dup').length, 2);
  assert.equal(byId['ex-zero-tp'].status, 'rejected');
  assert.equal(byId['ex-negative-tp'].status, 'rejected');
  assert.equal(byId['ex-unavailable'].status, 'excluded');
  assert.equal(byId['ex-vram-unknown'].status, 'pending');
  assert.ok(byId['ex-vram-unknown'].allReasons.some(r => r.code === 'vram_unknown'));
  assert.equal(byId['ex-no-bench'].status, 'pending');
  assert.ok(byId['ex-no-bench'].allReasons.some(r => r.code === 'missing_comparable_benchmark'));
  assert.equal(byId['ex-theory'].status, 'pending');
  assert.ok(byId['ex-theory'].allReasons.some(r => r.code === 'theoretical_not_in_measured_board'));
  assert.equal(byId['ex-scaled'].allInUsdPerHour, null);
  assert.ok(byId['ex-scaled'].allReasons.some(r => r.code === 'gpu_count_measurement_mismatch'));
  assert.equal(byId['ex-net-unknown'].status, 'pending');
  assert.equal(byId['ex-clore-conflict'].allInUsdPerHour, null);
  assert.equal(byId['ex-clore-conflict'].usdPerEqH100Hour, null);
  assert.ok(byId['ex-clore-conflict'].allReasons.some(r => r.code === 'billing_unit_conflict'));
  assert.equal(byId['ex-clore-conflict'].rawAmount, 240);
  assert.equal(byId['ex-usd-blockchain'].allInUsdPerHour, null);
  assert.ok(byId['ex-usd-blockchain'].allReasons.some(r => r.code === 'fx_missing'));
  assert.equal(byId['ex-slow-net'].status, 'excluded');
  assert.equal(byId['ex-backend-no'].status, 'excluded');
  const csv = reportCsv(report);
  assert.match(csv, /ex-clore-conflict/);
  assert.doesNotMatch(csv, /ex-clore-conflict,[^\n]*USD-Blockchain/);
});

test('NaN and Infinity throughput are rejected and ops hours do not change price', () => {
  const nan = offer();
  nan.id = 'ex-nan';
  nan.benchmarks = [{ ...nan.benchmarks[0], throughput: Number.NaN }];
  const inf = offer();
  inf.id = 'ex-inf';
  inf.benchmarks = [{ ...inf.benchmarks[0], throughput: Number.POSITIVE_INFINITY }];
  const withOps = offer();
  withOps.ops = {
    migrationDownload: { status: 'known', note: 'EXAMPLE 2h download', hours: 2 },
    overlapRent: { status: 'known', note: 'EXAMPLE overlap', hours: 1 },
    drain: { status: 'unknown' },
    stability: { status: 'unknown' },
    leaseCooldown: { status: 'known', note: 'EXAMPLE cooldown', hours: 4 },
  };
  const doc = comparableDocument();
  doc.offers = [nan, inf, withOps];
  const report = rankDocument(doc);
  assert.equal(report.rejected.find(r => r.offerId === 'ex-nan').status, 'rejected');
  assert.equal(report.rejected.find(r => r.offerId === 'ex-inf').status, 'rejected');
  const ranked = report.ranked.find(r => r.offerId === 'ex-a');
  assert.equal(ranked.usdPerEqH100Hour, 3.125);
  assert.equal(ranked.ops.migrationDownload.hours, 2);
  assert.match(reportText(report), /不折算收益/);
  assert.equal(JSON.stringify(report).includes('profitUsd'), false);
});

test('quote currency is not spent as a different payment currency', () => {
  const mixed = offer({
    offer: {
      id: 'ex-mixed',
      quote: { quoteCurrency: 'CLORE-Blockchain', paymentCurrency: 'USD' },
    },
  });
  const doc = comparableDocument();
  doc.offers = [mixed];
  const report = rankDocument(doc);
  const row = report.pending.find(r => r.offerId === 'ex-mixed');
  assert.ok(row);
  assert.equal(row.allInUsdPerHour, null);
  assert.ok(row.allReasons.some(r => r.code === 'quote_payment_currency_mismatch'));
});

test('a different revision is not mixed into the requested group', () => {
  const other = offer();
  other.id = 'ex-other-rev';
  other.benchmarks = [{
    ...other.benchmarks[0],
    workload: workload({ revision: 'rev-other' }),
  }];
  const doc = comparableDocument();
  doc.offers = [offer(), other];
  const report = rankDocument(doc);
  assert.deepEqual(report.ranked.map(r => r.offerId), ['ex-a']);
  assert.equal(report.pending.find(r => r.offerId === 'ex-other-rev').allReasons.some(r => r.code === 'benchmark_not_comparable'), true);
});

test('theoretical board stays separate and still is not an optimum', () => {
  const doc = edgesDocument();
  doc.offers = doc.offers.filter(o => o.id === 'ex-theory' || o.id === 'ex-a'.replace('ex-a', 'no'));
  const theory = edgesDocument().offers.find(o => o.id === 'ex-theory');
  const clean = offer();
  doc.offers = [clean, theory];
  const off = rankDocument(doc, { includeTheoretical: false });
  assert.equal(off.theoreticalBoards.length, 0);
  assert.equal(off.ranked.length, 1);
  const on = rankDocument(doc, { includeTheoretical: true });
  assert.equal(on.groups.length, 1);
  assert.equal(on.groups[0].rows.some(r => r.offerId === 'ex-theory'), false);
  assert.equal(on.theoreticalBoards.length, 1);
  assert.equal(on.theoreticalBoards[0].rows[0].offerId, 'ex-theory');
  assert.equal(on.optimalMachineSelected, false);
  assert.match(reportText(on), /理论代理榜/);
});

test('disabled hard gates require evidence and unknown availability does not pass', () => {
  const doc = comparableDocument();
  doc.requirements = {
    vram: { mode: 'disabled', evidence: '' },
    backend: { mode: 'disabled', evidence: 'EXAMPLE no backend constraint' },
    network: { mode: 'disabled', evidence: 'EXAMPLE no network floor' },
    disk: { mode: 'disabled', evidence: 'EXAMPLE no disk floor' },
  };
  assert.equal(rankDocument(doc).ok, false);
  doc.requirements.vram.evidence = 'EXAMPLE vram floor not used';
  const unknown = offer({ offer: { id: 'ex-avail', available: null, availabilityEvidence: '' } });
  doc.offers = [unknown];
  const report = rankDocument(doc);
  assert.equal(report.ok, true);
  assert.equal(report.pending[0].allReasons.some(r => r.code === 'availability_unknown'), true);
  assert.equal(report.ranked.length, 0);
});

test('month period and zero fee without evidence do not become an hourly price', () => {
  const month = offer({
    offer: {
      id: 'ex-month',
      quote: { period: 'month', periodEvidence: 'EXAMPLE monthly rate without an hour count' },
    },
  });
  const silentZero = offer();
  silentZero.id = 'ex-silent-zero';
  silentZero.quote = {
    ...silentZero.quote,
    components: {
      ...silentZero.quote.components,
      storage: { ...silentZero.quote.components.storage, amount: 0, evidence: '' },
    },
  };
  const doc = comparableDocument();
  doc.offers = [month, silentZero];
  const report = rankDocument(doc);
  assert.equal(report.ranked.length, 0);
  assert.ok(report.pending.find(r => r.offerId === 'ex-month').allReasons.some(r => r.code === 'billing_period_unknown'));
  assert.ok(report.pending.find(r => r.offerId === 'ex-silent-zero').allReasons.some(r => r.code === 'component_evidence_missing'));
});

test('ambiguous FX is not selected', () => {
  const doc = comparableDocument();
  const row = offer({
    currency: 'CLORE-Blockchain',
    period: 'day',
    amounts: { compute: 96, storage: 0, bandwidth: 0, platformFee: 0 },
    offer: {
      id: 'ex-fx',
      gpu: { count: 1, model: 'RTX 4090', vramGbEach: 24, vramScope: 'per_gpu', vramEvidence: 'EXAMPLE 24GB per GPU' },
      benchmarks: [{
        ...offer().benchmarks[0],
        throughput: 1000,
        gpuCountAtMeasurement: 1,
      }],
    },
  });
  doc.offers = [row];
  doc.fx = [
    doc.fx[0],
    { ...doc.fx[0], rate: 0.5, sourceUrl: 'https://example.invalid/fx/clore-b' },
  ];
  const report = rankDocument(doc);
  assert.equal(report.ranked.length, 0);
  assert.ok(report.pending[0].allReasons.some(r => r.code === 'fx_ambiguous'));
  assert.equal(AS_OF, doc.asOf);
});
