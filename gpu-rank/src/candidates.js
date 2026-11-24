import { cloreMarketplaceOffers } from './adapters/clore.js';
import { SCHEMA_INPUT } from './schema.js';

export const SCHEMA_CANDIDATES = 'gpu-rank.candidates.v1';

const PLACEHOLDER_WORKLOAD = {
  modelId: 'not-supplied',
  revision: 'not-supplied',
  precision: 'not-supplied',
  inputTokens: 0,
  outputTokens: 1,
  batchSize: 1,
  concurrency: 1,
  maxLatencyMs: 1,
  metric: 'not-supplied',
  protocol: {
    id: 'not-supplied',
    latencyStatistic: 'e2e_p99',
    engine: 'not-supplied',
    engineIdentity: 'must_match',
  },
};

// Turns a saved marketplace body into a candidate document. It does not add
// benchmarks, fees, FX, or a vendor expiry. ttlSeconds is optional and, when
// present, is labeled local_policy.
export function candidatesFromCloreBody(payload, {
  sourceUrl = 'https://api.clore.ai/v1/marketplace',
  collectedAt,
  asOf,
  ttlSeconds = null,
} = {}) {
  const normalized = cloreMarketplaceOffers(payload, { sourceUrl, collectedAt, expiresAt: null });
  const offers = normalized.offers.map(offer => ({
    ...offer,
    expiresAt: null,
    validity: localValidity(ttlSeconds),
  }));
  return {
    schemaVersion: SCHEMA_CANDIDATES,
    dataset: {
      id: `clore-candidates-${collectedAt}`,
      kind: 'market-snapshot',
      label: 'public Clore candidates, not a ranking',
      collectedAt,
      sourceUrls: [sourceUrl],
    },
    asOf: asOf || collectedAt,
    collectedAt,
    vendorGuaranteesAvailability: false,
    optimalMachineSelected: false,
    ranked: false,
    summary: normalized.summary,
    gaps: candidateGaps(ttlSeconds),
    offers,
  };
}

export function candidatesAsRankInput(candidates) {
  if (!candidates || candidates.schemaVersion !== SCHEMA_CANDIDATES) {
    throw new Error('candidatesAsRankInput requires gpu-rank.candidates.v1');
  }
  return {
    schemaVersion: SCHEMA_INPUT,
    dataset: candidates.dataset,
    asOf: candidates.asOf,
    workload: PLACEHOLDER_WORKLOAD,
    baselines: [],
    requirements: {
      vram: { mode: 'min_gb_per_gpu', minGb: 1 },
      backend: { mode: 'allowlist', names: ['not-supplied'] },
      network: { mode: 'min_mbps', downMbps: 1, upMbps: 1 },
      disk: { mode: 'min_gb', minGb: 1 },
    },
    fx: [],
    offers: candidates.offers,
  };
}

// evidence.offers[] patches existing candidates. A full rank input is emitted
// only when the caller supplies workload, baselines, and requirements.
// Missing fee amounts are not filled with zero.
export function enrichCandidates(candidates, evidence = {}) {
  if (evidence.inventMeasurements === true || evidence.inventFees === true || evidence.inventFx === true) {
    throw new Error('refusing to invent measurements, fees, or FX');
  }
  const patches = new Map((evidence.offers || []).map(item => [String(item.id), item.patch || {}]));
  const offers = (candidates.offers || []).map(offer => {
    const patch = patches.get(String(offer.id));
    return patch ? mergeDefined(offer, patch) : offer;
  });
  if (evidence.workload && evidence.baselines && evidence.requirements) {
    return {
      schemaVersion: SCHEMA_INPUT,
      dataset: { ...candidates.dataset, ...(evidence.dataset || {}) },
      asOf: evidence.asOf || candidates.asOf,
      workload: evidence.workload,
      baselines: evidence.baselines,
      requirements: evidence.requirements,
      fx: evidence.fx || [],
      maxAgeSeconds: evidence.maxAgeSeconds,
      offers,
    };
  }
  return { ...candidates, offers, enriched: true, optimalMachineSelected: false, ranked: false };
}

function localValidity(ttlSeconds) {
  if (ttlSeconds == null) {
    return { source: 'unknown', vendorGuaranteesAvailability: false };
  }
  return {
    source: 'local_policy',
    ttlSeconds,
    evidence: 'explicit local observation TTL; the marketplace payload has no expiresAt',
    vendorGuaranteesAvailability: false,
  };
}

function candidateGaps(ttlSeconds) {
  return [
    'no same-condition H100 measurement is included',
    'fee schedule is not in the marketplace payload',
    'FX is not included',
    'vendor expiresAt is absent',
    ttlSeconds == null
      ? 'no local observation TTL was configured'
      : `local observation TTL is ${ttlSeconds}s and is not a vendor availability guarantee`,
    'pre-rent recheck required',
    'Vast offers were not fetched',
    'placeholder workload not-supplied matches no measurement and produces no equivalent-H100 board',
  ];
}

function mergeDefined(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = mergeDefined(base[key], value);
    } else out[key] = value;
  }
  return out;
}
