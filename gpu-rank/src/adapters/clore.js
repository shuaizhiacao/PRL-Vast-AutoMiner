// Normalizes a Clore marketplace payload into audit offers.
// price.on_demand[currency] is recorded as per day because the host API says that
// for this field. price.usd.on_demand_clore is a different field and is ignored.
// The two descriptions are not applied to each other, and neither becomes an all-in
// hourly USD price. Fees, FX, VRAM, and benchmarks stay unknown.

export const ON_DEMAND_PERIOD = {
  field: 'price.on_demand',
  period: 'day',
  sourceUrl: 'https://docs.clore.ai/for-hosts/api',
  statement: 'servers[x].price.on_demand is documented as on-demand price per day',
};

const UNKNOWN_FEE = {
  known: false,
  amount: null,
  currency: null,
  period: null,
  unit: null,
  evidence: 'Clore renter_fees and creation_fees are not in the marketplace payload. GET /v1/renter_fees requires auth and is not called. Unknown fee is not zero.',
};

export function cloreMarketplaceOffers(payload, { sourceUrl, collectedAt, expiresAt }) {
  const servers = Array.isArray(payload?.servers) ? payload.servers : [];
  const offers = [];
  for (const server of servers) {
    const currencies = server?.price?.on_demand;
    const keys = currencies && typeof currencies === 'object' ? Object.keys(currencies) : [];
    if (!keys.length) {
      offers.push(oneOffer(server, null, null, { sourceUrl, collectedAt, expiresAt }));
      continue;
    }
    for (const currency of keys) {
      offers.push(oneOffer(server, currency, currencies[currency], { sourceUrl, collectedAt, expiresAt }));
    }
  }
  return {
    offers,
    ignoredFields: ['price.usd', 'price.usd.on_demand_clore'],
    note: 'Each on_demand currency is a separate payment currency. USD-Blockchain is not applied to a CLORE payment. price.usd is ignored.',
    summary: summarizeCloreOffers(offers),
  };
}

export function summarizeCloreOffers(offers) {
  const currencies = {};
  let billingUnitConflict = 0;
  let feesCompleteTrue = 0;
  let periodSet = 0;
  let availableTrue = 0;
  const priceUnit = { whole_machine: 0, per_gpu: 0, unknown: 0 };
  for (const offer of offers) {
    const currency = offer?.quote?.paymentCurrency || '(none)';
    currencies[currency] = (currencies[currency] || 0) + 1;
    if (offer?.quote?.billingUnitConflict === true) billingUnitConflict += 1;
    if (offer?.quote?.feesComplete === true) feesCompleteTrue += 1;
    if (offer?.quote?.period) periodSet += 1;
    if (offer?.available === true) availableTrue += 1;
    const unit = offer?.quote?.priceUnit;
    if (unit === 'whole_machine' || unit === 'per_gpu') priceUnit[unit] += 1;
    else priceUnit.unknown += 1;
  }
  return {
    offerCount: offers.length,
    currencies,
    billingUnitConflict,
    feesCompleteTrue,
    periodSet,
    availableTrue,
    priceUnit,
    ranked: false,
  };
}

function oneOffer(server, currency, amount, meta) {
  const gpuArray = Array.isArray(server?.gpu_array) ? server.gpu_array.filter(s => typeof s === 'string' && s.trim()) : [];
  const models = [...new Set(gpuArray)];
  const partial = server?.partial_gpu_rental;
  // partial_gpu_rental === false is not treated as proof of a whole-machine price.
  // Host docs also say a partial rental scales the per-day price by gpu_count.
  return {
    id: currency ? `clore:${server?.id}:${currency}` : `clore:${server?.id}:no-price`,
    marketplace: 'clore',
    machineFingerprint: `clore:${server?.id}`,
    sourceUrl: meta.sourceUrl,
    collectedAt: meta.collectedAt,
    expiresAt: meta.expiresAt,
    available: server?.rented === true ? false : null,
    availabilityEvidence: server?.rented === true ? 'marketplace rented===true' : '',
    gpu: {
      count: gpuArray.length || null,
      model: models.length === 1 ? models[0] : (models.length ? models.join(' + ') : null),
      vramGbEach: null,
      vramScope: 'unknown',
      vramEvidence: '',
    },
    diskGb: null,
    diskEvidence: '',
    network: { downMbps: null, upMbps: null, evidence: '' },
    backend: { name: null, compatible: null, evidence: '' },
    quote: {
      priceUnit: null,
      amount: typeof amount === 'number' ? amount : null,
      quoteCurrency: currency,
      paymentCurrency: currency,
      period: currency ? ON_DEMAND_PERIOD.period : null,
      periodEvidence: currency ? `${ON_DEMAND_PERIOD.sourceUrl} — ${ON_DEMAND_PERIOD.statement}` : '',
      billingUnitConflict: false,
      feesComplete: false,
      feesCompleteEvidence: '',
      components: {
        compute: { ...UNKNOWN_FEE },
        storage: { ...UNKNOWN_FEE },
        bandwidth: { ...UNKNOWN_FEE },
        platformFee: { ...UNKNOWN_FEE },
      },
    },
    benchmarks: [],
    ops: unknownOps(),
    raw: {
      serverId: server?.id ?? null,
      rented: server?.rented ?? null,
      partialGpuRental: partial === undefined ? null : partial,
      ignoredPriceUsd: server?.price?.usd ?? null,
    },
  };
}

function unknownOps() {
  return {
    migrationDownload: { status: 'unknown' },
    overlapRent: { status: 'unknown' },
    drain: { status: 'unknown' },
    stability: { status: 'unknown' },
    leaseCooldown: { status: 'unknown' },
  };
}
