import assert from 'node:assert/strict';
import test from 'node:test';
import { cloreMarketplaceOffers } from '../src/adapters/clore.js';
import { vastSnapshotOffers } from '../src/adapters/vast.js';
import { rankDocument } from '../src/rank.js';
import { comparableDocument, workload } from '../fixtures/factory.js';

const clorePayload = {
  servers: [{
    id: 7,
    rented: false,
    partial_gpu_rental: false,
    price: {
      on_demand: { 'CLORE-Blockchain': 240, 'USD-Blockchain': 48 },
      usd: { on_demand_clore: 2 },
    },
    gpu_array: ['NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 4090'],
    specs: { gpu: '2x NVIDIA GeForce RTX 4090', gpuram: 24 },
  }],
};

test('Clore currencies stay separate and price.usd is not an hourly USD price', () => {
  const normalized = cloreMarketplaceOffers(clorePayload, {
    sourceUrl: 'https://api.clore.ai/v1/marketplace',
    collectedAt: '2026-11-24T11:00:00.000Z',
    expiresAt: '2026-11-24T18:00:00.000Z',
  });
  const clore = normalized.offers.find(o => o.quote.paymentCurrency === 'CLORE-Blockchain');
  const usdChain = normalized.offers.find(o => o.quote.paymentCurrency === 'USD-Blockchain');
  assert.equal(clore.quote.amount, 240);
  assert.equal(clore.quote.quoteCurrency, 'CLORE-Blockchain');
  assert.notEqual(clore.quote.amount, 48);
  assert.equal(clore.quote.period, null);
  assert.equal(clore.quote.billingUnitConflict, true);
  assert.equal(clore.quote.components.platformFee.known, false);
  assert.equal(clore.quote.components.platformFee.amount, null);
  assert.equal(clore.quote.feesComplete, false);
  assert.equal(usdChain.quote.amount, 48);
  assert.notEqual(usdChain.quote.paymentCurrency, 'USD');
  assert.equal(usdChain.raw.ignoredPriceUsd.on_demand_clore, 2);
  assert.equal(clore.gpu.count, 2);
  assert.equal(clore.gpu.vramGbEach, null);
  assert.equal(clore.available, null);

  const doc = comparableDocument();
  doc.dataset = { ...doc.dataset, kind: 'market-snapshot', label: 'imported Clore snapshot, not a ranking', id: 'clore-import' };
  doc.offers = normalized.offers;
  const report = rankDocument(doc);
  assert.equal(report.groups.length, 0);
  assert.equal(report.optimalMachineSelected, false);
  for (const row of [...report.pending, ...report.rejected, ...report.excluded]) {
    assert.equal(row.allInUsdPerHour, null);
    assert.equal(row.usdPerEqH100Hour, null);
  }
  assert.ok(report.pending.some(r => r.paymentCurrency === 'CLORE-Blockchain' && r.rawAmount === 240));
  assert.equal(workload().metric, doc.workload.metric);
});

test('Vast snapshot import does not multiply cards or zero-fill bandwidth', () => {
  const normalized = vastSnapshotOffers({
    offers: [{
      id: 99,
      gpu_name: 'RTX 4090',
      num_gpus: 8,
      gpu_ram: 24576,
      dph_total: 1.5,
      storage_cost: 0.1,
      inet_up_cost: 0.02,
      inet_down_cost: 0.01,
      rentable: true,
      rented: false,
    }],
  }, {
    sourceUrl: 'https://example.invalid/vast-snapshot',
    collectedAt: '2026-11-24T11:00:00.000Z',
    expiresAt: '2026-11-24T18:00:00.000Z',
  });
  const row = normalized.offers[0];
  assert.equal(row.gpu.count, 8);
  assert.equal(row.quote.amount, 1.5);
  assert.equal(row.quote.components.bandwidth.known, false);
  assert.equal(row.quote.components.bandwidth.amount, null);
  assert.equal(row.quote.components.compute.known, false);
  assert.notEqual(row.quote.amount, 1.5 * 8);
  const doc = comparableDocument();
  doc.dataset = { ...doc.dataset, kind: 'market-snapshot', label: 'imported Vast snapshot, not a ranking', id: 'vast-import' };
  doc.offers = normalized.offers;
  const report = rankDocument(doc);
  assert.equal(report.ranked.length, 0);
  assert.equal(report.optimalMachineSelected, false);
  assert.equal(report.pending[0].allInUsdPerHour, null);
  assert.ok(report.pending[0].allReasons.some(r => r.code === 'fee_schedule_incomplete'));
  assert.ok(report.pending[0].allReasons.some(r => r.code === 'missing_comparable_benchmark'));
});
