import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { candidatesAsRankInput, candidatesFromCloreBody, enrichCandidates } from '../src/candidates.js';
import { fetchPublicSnapshots } from '../src/fetch-public.js';
import { publicGet } from '../src/http.js';
import { rankDocument } from '../src/rank.js';
import { reportCsv } from '../src/report.js';
import { comparableDocument, measuredBench, offer, workload } from '../fixtures/factory.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function rankedIds(doc) {
  const report = rankDocument(doc);
  return { report, ids: report.ranked.map(row => row.offerId) };
}

test('F1 invalid latency cannot enter a measured or theoretical board', () => {
  const bad = [undefined, null, '', 'not-a-number', '900', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1];
  for (const latencyMs of bad) {
    const doc = comparableDocument();
    const row = offer();
    row.benchmarks = [{ ...row.benchmarks[0], latencyMs }];
    doc.offers = [row];
    const report = rankDocument(doc);
    assert.equal(report.ranked.length, 0, `latency ${String(latencyMs)} ranked`);
    assert.equal(report.theoreticalBoards.length, 0);
    assert.equal(report.accounting.balanced, true);
  }
  const zero = comparableDocument();
  const zeroOffer = offer();
  zeroOffer.benchmarks = [{ ...zeroOffer.benchmarks[0], latencyMs: 0 }];
  zero.offers = [zeroOffer];
  assert.equal(rankDocument(zero).ranked.length, 1);
  const baseline = comparableDocument();
  baseline.baselines[0] = { ...baseline.baselines[0], latencyMs: 'not-a-number' };
  baseline.offers = baseline.offers.filter(row => row.benchmarks[0].baselineId === baseline.baselines[0].id);
  assert.equal(rankDocument(baseline).ranked.length, 0);
  assert.ok(rankDocument(baseline).invalidBaselines.some(item => item.problems.includes('latencyMs')));
});

test('F2 an 8-GPU H100 baseline is a node unit and is not divided into single H100s', () => {
  const doc = comparableDocument();
  doc.baselines.push({
    ...doc.baselines[0],
    id: 'h100-sxm-80-hbm3-x8',
    gpuCount: 8,
    throughput: 8000,
    machineFingerprint: 'example-baseline:x8',
  });
  const row = offer({
    amounts: { compute: 1, storage: 0, bandwidth: 0, platformFee: 0 },
    offer: {
      id: 'ex-node',
      machineFingerprint: 'example:ex-node',
      gpu: { count: 1, model: 'RTX 4090', vramGbEach: 24, vramScope: 'per_gpu', vramEvidence: 'EXAMPLE 24GB per GPU' },
      benchmarks: [measuredBench({
        offerId: 'ex-node', throughput: 1000, gpuCountAtMeasurement: 1, baselineId: 'h100-sxm-80-hbm3-x8',
      })],
    },
  });
  doc.offers = [row];
  const report = rankDocument(doc);
  const ranked = report.ranked[0];
  assert.equal(ranked.equivalenceUnit, '8xH100-node');
  assert.equal(ranked.baselineGpuCount, 8);
  assert.equal(ranked.eqBaseline, 0.125);
  assert.equal(ranked.usdPerEqBaselineHour, 8);
  assert.equal(ranked.eqH100, null);
  assert.equal(ranked.usdPerEqH100Hour, null);
  assert.equal(report.groups[0].baseline.gpuCount, 8);
  const text = reportCsv(report);
  assert.match(text, /8xH100-node/);
  assert.doesNotMatch(text, /ex-node,[^\n]*1xH100,/);
});

test('F3 measurement hardware and protocol must match the quoted machine', () => {
  const changedModel = comparableDocument();
  changedModel.offers = [offer({ offer: { gpu: { model: 'RTX 3090' } } })];
  assert.ok(rankDocument(changedModel).pending[0].allReasons.some(r => r.code === 'benchmark_hardware_mismatch'));

  const otherStat = comparableDocument();
  const bench = { ...offer().benchmarks[0], protocol: { ...workload().protocol, latencyStatistic: 'p50' } };
  otherStat.offers = [offer({ offer: { benchmarks: [bench] } })];
  assert.ok(rankDocument(otherStat).pending[0].allReasons.some(r => r.code === 'benchmark_protocol_mismatch'));

  const theoreticalBaseline = comparableDocument();
  theoreticalBaseline.baselines[0] = { ...theoreticalBaseline.baselines[0], kind: 'theoretical' };
  theoreticalBaseline.baselines.pop();
  assert.equal(rankDocument(theoreticalBaseline).ranked.length, 0);
});

test('F4 missing VRAM scope does not pass a per-GPU gate', () => {
  for (const vramScope of [undefined, null, '', 'total', 'unknown']) {
    const doc = comparableDocument();
    const row = offer();
    row.gpu = { ...row.gpu, vramScope };
    doc.offers = [row];
    const report = rankDocument(doc);
    assert.equal(report.ranked.length, 0, `scope ${String(vramScope)} ranked`);
    assert.ok(report.pending[0].allReasons.some(r => r.code === 'vram_scope_unknown'));
  }
  const ok = comparableDocument();
  ok.offers = [offer()];
  assert.equal(rankDocument(ok).ranked[0].offerId, 'ex-a');
});

test('F5 local TTL is not a vendor expiry and candidates do not invent a ranking', () => {
  const payload = {
    code: 0,
    servers: [{
      id: 7,
      rented: false,
      price: { on_demand: { 'CLORE-Blockchain': 240, 'USD-Blockchain': 48 }, usd: { on_demand_clore: 2 } },
      gpu_array: ['NVIDIA GeForce RTX 4090'],
    }],
  };
  const candidates = candidatesFromCloreBody(payload, {
    collectedAt: '2026-11-24T12:00:00.000Z',
    asOf: '2026-11-24T12:30:00.000Z',
    ttlSeconds: 3600,
  });
  assert.equal(candidates.offers[0].expiresAt, null);
  assert.equal(candidates.offers[0].validity.source, 'local_policy');
  assert.equal(candidates.offers[0].validity.vendorGuaranteesAvailability, false);
  assert.equal(candidates.vendorGuaranteesAvailability, false);
  const report = rankDocument(candidatesAsRankInput(candidates));
  assert.equal(report.groups.length, 0);
  assert.equal(report.optimalMachineSelected, false);
  assert.equal(report.pending.length + report.rejected.length + report.excluded.length + report.theoreticalBoards.length, candidates.offers.length);
  assert.ok(report.pending.some(row => row.validitySource === 'local_policy' && row.vendorGuaranteesAvailability === false));
  assert.ok(report.pending.some(row => row.notes.includes('pre_rent_recheck')));
  const stale = candidatesFromCloreBody(payload, {
    collectedAt: '2026-11-24T10:00:00.000Z',
    asOf: '2026-11-24T12:00:00.000Z',
    ttlSeconds: 60,
  });
  const staleReport = rankDocument(candidatesAsRankInput(stale));
  assert.ok(staleReport.rejected.some(row => row.allReasons.some(r => r.code === 'local_observation_stale')));
  assert.ok(!staleReport.rejected.some(row => row.allReasons.some(r => r.code === 'vendor_expired')));
  assert.throws(() => enrichCandidates(candidates, { inventMeasurements: true }), /invent/);
});

test('F5 enrich refuses invented fees and can apply caller evidence', () => {
  const payload = {
    servers: [{ id: 1, rented: false, price: { on_demand: { 'USD-Blockchain': 10 } }, gpu_array: ['EXAMPLE GPU'] }],
  };
  const candidates = candidatesFromCloreBody(payload, {
    collectedAt: '2026-11-24T11:00:00.000Z',
    asOf: '2026-11-24T12:00:00.000Z',
    ttlSeconds: 7200,
  });
  assert.throws(() => enrichCandidates(candidates, { inventFees: true }));
  const doc = comparableDocument();
  const evidenceOffer = doc.offers[0];
  const enriched = enrichCandidates(candidates, {
    dataset: { id: 'example-enriched', kind: 'example', label: 'EXAMPLE enriched, not a market ranking' },
    workload: doc.workload,
    baselines: doc.baselines,
    requirements: doc.requirements,
    fx: [],
    asOf: doc.asOf,
    offers: [{ id: candidates.offers[0].id, patch: { benchmarks: evidenceOffer.benchmarks, gpu: evidenceOffer.gpu, machineFingerprint: evidenceOffer.machineFingerprint } }],
  });
  assert.equal(enriched.schemaVersion, 'gpu-rank.input.v1');
  const report = rankDocument(enriched);
  assert.equal(report.groups.length, 0);
  assert.equal(report.optimalMachineSelected, false);
});

test('F6 duplicate baseline ids fail in either order', () => {
  const doc = comparableDocument();
  const first = doc.baselines[0];
  const second = doc.baselines[1];
  const copy = { ...first, throughput: first.throughput * 2 };
  doc.baselines = [first, copy, second];
  const forward = rankDocument(doc);
  doc.baselines = [copy, first, second];
  const backward = rankDocument(doc);
  assert.equal(forward.ok, false);
  assert.equal(backward.ok, false);
  assert.deepEqual(forward.errors, backward.errors);
  assert.match(forward.errors.join('\n'), /duplicate baseline id/);
});

test('F7 overflow stays in the rejected bucket and the offer count balances', () => {
  const doc = comparableDocument();
  doc.baselines[0] = { ...doc.baselines[0], throughput: 1e-308 };
  const row = offer();
  row.benchmarks = [{ ...row.benchmarks[0], throughput: 1e308 }];
  doc.offers = [row];
  doc.baselines = [doc.baselines[0]];
  const report = rankDocument(doc);
  assert.equal(report.ranked.length, 0);
  assert.ok(report.rejected.some(item => item.allReasons.some(r => r.code === 'arithmetic_out_of_range')));
  assert.equal(report.accounting.balanced, true);
  assert.equal(report.accounting.offers, 1);
});

test('F8 byte cap and timeout do not block the next public GET', async () => {
  let reads = 0;
  const capped = await publicGet('https://api.clore.ai/v1/marketplace', {
    byteCap: 4,
    timeoutMs: 1000,
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => null, forEach() {} },
      body: {
        getReader() {
          return {
            async read() {
              reads += 1;
              if (reads === 1) return { done: false, value: Buffer.from('abcdef') };
              return { done: true, value: undefined };
            },
            async cancel() { this.cancelled = true; },
            releaseLock() {},
          };
        },
      },
    }),
  });
  assert.equal(capped.truncated, true);
  assert.ok(capped.bytes <= 4);

  const multibyte = await publicGet('https://docs.vast.ai/api-reference/hello-world', {
    timeoutMs: 1000,
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => null, forEach() {} },
      text: async () => '你',
    }),
  });
  assert.equal(multibyte.bytes, Buffer.byteLength('你'));

  const out = mkdtempSync(path.join(tmpdir(), 'gpu-rank-timeout-'));
  const manifest = await fetchPublicSnapshots(out, {
    timeoutMs: 30,
    now: new Date('2026-11-24T12:00:00.000Z'),
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      if (String(url).includes('marketplace')) {
        const fail = () => reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
        if (init.signal?.aborted) fail();
        else init.signal?.addEventListener('abort', fail, { once: true });
        return;
      }
      resolve({ status: 204, headers: { get: () => null, forEach() {} }, text: async () => '' });
    }),
  });
  const market = manifest.results.find(item => item.id === 'clore-marketplace');
  const vast = manifest.results.find(item => item.id === 'vast-hello-world-doc');
  assert.equal(market.status, null);
  assert.match(market.gap, /timed out|aborted/i);
  assert.equal(vast.status, 204);
});

test('F9 CSV quotes CR and neutralizes a leading formula', () => {
  const doc = comparableDocument();
  doc.offers = [offer({ offer: { id: 'ex-a', marketplace: 'abc\rdef' } })];
  const csv = reportCsv(rankDocument(doc));
  const rows = parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[1][rows[0].indexOf('marketplace')], 'abc\rdef');
  const evil = comparableDocument();
  evil.offers = [offer({ offer: { id: ' =1+1', marketplace: ' @cmd' } })];
  const evilCsv = reportCsv(rankDocument(evil));
  assert.match(evilCsv, /' =1\+1/);
  const parsed = parseCsv(evilCsv);
  assert.equal(parsed[1][parsed[0].indexOf('offerId')], "' =1+1");
});

test('F10 a different settlement currency stays pending', () => {
  const doc = comparableDocument();
  doc.offers = [offer({ offer: { quote: { quoteCurrency: 'USD', paymentCurrency: 'CLORE-Blockchain' } } })];
  const report = rankDocument(doc);
  assert.equal(report.ranked.length, 0);
  assert.ok(report.pending[0].allReasons.some(r => r.code === 'quote_payment_currency_mismatch'));
});

test('F11 tie order does not depend on localeCompare', () => {
  const doc = comparableDocument();
  const a = offer({ offer: { id: 'é-b' } });
  const b = offer({ offer: { id: 'a-b' } });
  doc.offers = [a, b];
  const forward = rankDocument(doc).ranked.map(row => row.offerId);
  doc.offers = [b, a];
  const backward = rankDocument(doc).ranked.map(row => row.offerId);
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward, [...forward].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
});

test('candidates CLI writes a real pending roster and no equivalent board', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gpu-rank-candidates-'));
  const body = path.join(dir, 'body.json');
  writeFileSync(body, JSON.stringify({
    servers: [{ id: 9, rented: false, price: { on_demand: { 'CLORE-Blockchain': 3 } }, gpu_array: ['EXAMPLE GPU'] }],
  }));
  const cli = path.join(root, 'cli.js');
  const result = spawnSync(process.execPath, [cli, 'candidates', '--body', body, '--collected-at', '2026-11-24T12:00:00.000Z', '--as-of', '2026-11-24T12:10:00.000Z', '--ttl-seconds', '3600', '--out', dir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  assert.equal(summary.ranked, 0);
  assert.equal(summary.optimalMachineSelected, false);
  assert.equal(summary.vendorGuaranteesAvailability, false);
  const report = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8'));
  assert.equal(report.groups.length, 0);
  assert.ok(report.pending.length >= 1);
});

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; }
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  return rows.filter(item => item.length > 1 || item[0] !== '');
}
