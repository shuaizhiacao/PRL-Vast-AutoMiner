export const AS_OF = '2026-11-24T12:00:00.000Z';

export function workload(overrides = {}) {
  return {
    modelId: 'example/model',
    revision: 'rev-example-1',
    precision: 'fp16',
    inputTokens: 512,
    outputTokens: 128,
    batchSize: 1,
    concurrency: 1,
    maxLatencyMs: 2000,
    metric: 'output_tokens_per_second',
    protocol: {
      id: 'example-protocol-v1',
      latencyStatistic: 'e2e_p99',
      engine: 'vllm-example',
      engineIdentity: 'must_match',
    },
    ...overrides,
  };
}

export function measuredBench(partial = {}) {
  const id = partial.offerId || 'ex-a';
  const model = partial.gpuModelAtMeasurement || 'RTX 4090';
  const count = partial.gpuCountAtMeasurement ?? 2;
  return {
    kind: 'measured',
    throughput: 800,
    throughputScope: 'whole_machine',
    gpuCountAtMeasurement: count,
    gpuModelAtMeasurement: model,
    vramGbEachAtMeasurement: partial.vramGbEachAtMeasurement ?? (model === 'L40S' ? 48 : 24),
    vramScopeAtMeasurement: 'per_gpu',
    machineFingerprintAtMeasurement: partial.machineFingerprintAtMeasurement || `example:${id}`,
    metric: 'output_tokens_per_second',
    workload: workload(),
    protocol: workload().protocol,
    latencyMs: 900,
    sourceUrl: `https://example.invalid/bench/${id}`,
    collectedAt: '2026-11-24T10:30:00.000Z',
    baselineId: 'h100-sxm-80-hbm3',
    ...partial,
  };
}

export function requirements() {
  return {
    vram: { mode: 'min_gb_per_gpu', minGb: 24 },
    backend: { mode: 'allowlist', names: ['vllm'] },
    network: { mode: 'min_mbps', downMbps: 100, upMbps: 50 },
    disk: { mode: 'min_gb', minGb: 100 },
  };
}

export function ops(overrides = {}) {
  const base = {
    migrationDownload: { status: 'unknown' },
    overlapRent: { status: 'unknown' },
    drain: { status: 'unknown' },
    stability: { status: 'unknown' },
    leaseCooldown: { status: 'unknown' },
  };
  return { ...base, ...overrides };
}

export function baseline(id, formFactor, memoryGeneration, throughput = 1000) {
  return {
    id,
    kind: 'measured',
    gpu: { model: 'H100', formFactor, vramGb: 80, memoryGeneration },
    gpuCount: 1,
    throughput,
    throughputScope: 'whole_machine',
    metric: 'output_tokens_per_second',
    workload: workload(),
    protocol: workload().protocol,
    machineFingerprint: `example-baseline:${id}`,
    latencyMs: 400,
    sourceUrl: `https://example.invalid/bench/${id}`,
    collectedAt: '2026-11-24T10:00:00.000Z',
    evidence: 'EXAMPLE whole-machine measurement for this fixture',
  };
}

function fee(amount, currency, period, evidence) {
  return { known: true, amount, currency, period, unit: 'whole_machine', evidence };
}

export function offer(overrides = {}) {
  const currency = overrides.currency || 'USD';
  const period = overrides.period || 'hour';
  const amounts = overrides.amounts || { compute: 2, storage: 0.25, bandwidth: 0.125, platformFee: 0.125 };
  const base = {
    id: 'ex-a',
    marketplace: 'example',
    sourceUrl: 'https://example.invalid/offer/ex-a',
    collectedAt: '2026-11-24T11:00:00.000Z',
    expiresAt: '2026-11-24T18:00:00.000Z',
    available: true,
    availabilityEvidence: 'EXAMPLE available',
    machineFingerprint: 'example:ex-a',
    gpu: {
      count: 2,
      model: 'RTX 4090',
      vramGbEach: 24,
      vramScope: 'per_gpu',
      vramEvidence: 'EXAMPLE 24GB per GPU',
    },
    diskGb: 200,
    diskEvidence: 'EXAMPLE disk',
    network: { downMbps: 1000, upMbps: 500, evidence: 'EXAMPLE quoted bandwidth' },
    backend: { name: 'vllm', compatible: true, evidence: 'EXAMPLE image contains vllm' },
    quote: {
      priceUnit: 'whole_machine',
      amount: amounts.compute + amounts.storage + amounts.bandwidth + amounts.platformFee,
      quoteCurrency: currency,
      paymentCurrency: currency,
      period,
      periodEvidence: `EXAMPLE period ${period}`,
      feesComplete: true,
      feesCompleteEvidence: 'EXAMPLE these four components are the entire charge',
      components: {
        compute: fee(amounts.compute, currency, period, 'EXAMPLE compute'),
        storage: fee(amounts.storage, currency, period, 'EXAMPLE storage'),
        bandwidth: fee(amounts.bandwidth, currency, period, 'EXAMPLE bandwidth'),
        platformFee: fee(amounts.platformFee, currency, period, 'EXAMPLE platform fee'),
      },
    },
    benchmarks: [measuredBench({ offerId: 'ex-a', gpuCountAtMeasurement: 2, throughput: 800, latencyMs: 900 })],
    ops: ops(),
  };
  return merge(base, overrides.offer || {});
}

function merge(base, patch) {
  if (patch == null) return base;
  const out = { ...base, ...patch };
  for (const key of ['gpu', 'network', 'backend', 'quote', 'ops']) {
    if (patch[key] && typeof patch[key] === 'object' && !Array.isArray(patch[key])) {
      out[key] = { ...base[key], ...patch[key] };
    }
  }
  if (patch.quote?.components) {
    out.quote = { ...out.quote, components: { ...base.quote.components, ...patch.quote.components } };
  }
  return out;
}

export function comparableDocument() {
  const sxm = offer();
  const cheaperSticker = offer({
    offer: {
      id: 'ex-b',
      sourceUrl: 'https://example.invalid/offer/ex-b',
      machineFingerprint: 'example:ex-b',
      gpu: { count: 1, model: 'RTX 4090', vramGbEach: 24, vramScope: 'per_gpu', vramEvidence: 'EXAMPLE 24GB per GPU' },
      benchmarks: [measuredBench({
        offerId: 'ex-b', throughput: 500, gpuCountAtMeasurement: 1, latencyMs: 700,
      })],
    },
    amounts: { compute: 1, storage: 0.5, bandwidth: 0.25, platformFee: 0.25 },
  });
  const clore = offer({
    currency: 'CLORE-Blockchain',
    period: 'day',
    amounts: { compute: 96, storage: 0, bandwidth: 0, platformFee: 0 },
    offer: {
      id: 'ex-clore',
      sourceUrl: 'https://example.invalid/offer/ex-clore',
      machineFingerprint: 'example:ex-clore',
      gpu: { count: 1, model: 'RTX 4090', vramGbEach: 24, vramScope: 'per_gpu', vramEvidence: 'EXAMPLE 24GB per GPU' },
      benchmarks: [measuredBench({
        offerId: 'ex-clore', throughput: 1000, gpuCountAtMeasurement: 1, latencyMs: 800,
      })],
    },
  });
  const pcie = offer({
    amounts: { compute: 2, storage: 0, bandwidth: 0, platformFee: 0 },
    offer: {
      id: 'ex-pcie',
      sourceUrl: 'https://example.invalid/offer/ex-pcie',
      machineFingerprint: 'example:ex-pcie',
      gpu: { count: 1, model: 'L40S', vramGbEach: 48, vramScope: 'per_gpu', vramEvidence: 'EXAMPLE 48GB per GPU' },
      benchmarks: [measuredBench({
        offerId: 'ex-pcie', throughput: 250, gpuCountAtMeasurement: 1, gpuModelAtMeasurement: 'L40S',
        vramGbEachAtMeasurement: 48, latencyMs: 1100, baselineId: 'h100-pcie-80-hbm2e',
      })],
    },
  });
  return {
    schemaVersion: 'gpu-rank.input.v1',
    dataset: {
      id: 'example-comparable',
      kind: 'example',
      label: 'EXAMPLE — not a live market ranking',
      collectedAt: '2026-11-24T11:30:00.000Z',
      sourceUrls: ['https://example.invalid/fixture/comparable'],
    },
    asOf: AS_OF,
    workload: workload(),
    baselines: [
      baseline('h100-sxm-80-hbm3', 'SXM', 'HBM3'),
      baseline('h100-pcie-80-hbm2e', 'PCIe', 'HBM2e'),
    ],
    requirements: requirements(),
    maxAgeSeconds: 86400,
    fx: [{
      base: 'CLORE-Blockchain',
      quote: 'USD',
      rate: 0.25,
      sourceUrl: 'https://example.invalid/fx/clore',
      asOf: '2026-11-24T11:30:00.000Z',
      expiresAt: '2026-11-24T18:00:00.000Z',
    }],
    offers: [sxm, cheaperSticker, clore, pcie],
  };
}

export function edgesDocument() {
  const good = () => offer();
  const perGpu = good();
  perGpu.id = 'ex-per-gpu';
  perGpu.quote = { ...perGpu.quote, priceUnit: 'per_gpu' };
  const unknownFee = good();
  unknownFee.id = 'ex-unknown-fee';
  unknownFee.quote = {
    ...unknownFee.quote,
    feesComplete: false,
    feesCompleteEvidence: '',
    components: {
      ...unknownFee.quote.components,
      platformFee: { ...unknownFee.quote.components.platformFee, known: false, amount: null, evidence: '' },
    },
  };
  const expired = good();
  expired.id = 'ex-expired';
  expired.expiresAt = '2026-11-24T11:00:00.000Z';
  const dupA = good();
  dupA.id = 'ex-dup';
  const dupB = good();
  dupB.id = 'ex-dup';
  dupB.sourceUrl = 'https://example.invalid/offer/ex-dup-b';
  const zeroTp = good();
  zeroTp.id = 'ex-zero-tp';
  zeroTp.benchmarks = [{ ...zeroTp.benchmarks[0], throughput: 0 }];
  const negativeTp = good();
  negativeTp.id = 'ex-negative-tp';
  negativeTp.benchmarks = [{ ...negativeTp.benchmarks[0], throughput: -5 }];
  const unavailable = good();
  unavailable.id = 'ex-unavailable';
  unavailable.available = false;
  unavailable.availabilityEvidence = 'EXAMPLE rented';
  const vramUnknown = good();
  vramUnknown.id = 'ex-vram-unknown';
  vramUnknown.gpu = { ...vramUnknown.gpu, vramGbEach: null, vramEvidence: '' };
  const noBench = good();
  noBench.id = 'ex-no-bench';
  noBench.benchmarks = [];
  const theoretical = good();
  theoretical.id = 'ex-theory';
  theoretical.benchmarks = [{
    ...theoretical.benchmarks[0],
    kind: 'theoretical',
    throughput: 900,
    citationUrl: 'https://example.invalid/papers/theory',
    citationQuote: 'EXAMPLE cited proxy, not a measurement of this machine',
  }];
  const scaled = good();
  scaled.id = 'ex-scaled';
  scaled.benchmarks = [{ ...scaled.benchmarks[0], gpuCountAtMeasurement: 1, throughput: 400 }];
  const netUnknown = good();
  netUnknown.id = 'ex-net-unknown';
  netUnknown.network = { downMbps: null, upMbps: null, evidence: '' };
  const conflict = offer({
    currency: 'CLORE-Blockchain',
    period: 'day',
    amounts: { compute: 240, storage: 0, bandwidth: 0, platformFee: 0 },
    offer: {
      id: 'ex-clore-conflict',
      machineFingerprint: 'example:ex-clore-conflict',
      gpu: { count: 1, model: 'RTX 4090', vramGbEach: 24, vramScope: 'per_gpu', vramEvidence: 'EXAMPLE 24GB per GPU' },
      benchmarks: [measuredBench({
        offerId: 'ex-clore-conflict', throughput: 1000, gpuCountAtMeasurement: 1, latencyMs: 800,
      })],
      quote: {
        billingUnitConflict: true,
        documentationConflicts: [{ field: 'price.usd.on_demand_clore', period: 'hour', amount: 2 }],
        decoyUsdBlockchainPerDay: 48,
      },
    },
  });
  const stable = offer({
    currency: 'USD-Blockchain',
    offer: { id: 'ex-usd-blockchain' },
  });
  const slowNet = good();
  slowNet.id = 'ex-slow-net';
  slowNet.network = { downMbps: 10, upMbps: 10, evidence: 'EXAMPLE quoted' };
  const backendNo = good();
  backendNo.id = 'ex-backend-no';
  backendNo.backend = { name: 'vllm', compatible: false, evidence: 'EXAMPLE rejected by image' };
  return documentWith([
    perGpu, unknownFee, expired, dupA, dupB, zeroTp, negativeTp, unavailable, vramUnknown,
    noBench, theoretical, scaled, netUnknown, conflict, stable, slowNet, backendNo,
  ], { id: 'example-edges' });
}

export function documentWith(offers, extras = {}) {
  const doc = comparableDocument();
  doc.dataset = { ...doc.dataset, id: extras.id || 'example-edges', ...extras.dataset };
  doc.offers = offers;
  if (extras.fx) doc.fx = extras.fx;
  if (extras.baselines) doc.baselines = extras.baselines;
  if (extras.workload) doc.workload = extras.workload;
  return doc;
}
