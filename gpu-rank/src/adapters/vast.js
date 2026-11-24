// Imports an already-downloaded Vast offer snapshot. It does not call Vast.
// Official search is POST /api/v0/bundles/ with a bearer key, so this package
// does not fetch offers. dph_total is kept as a raw number. Bandwidth and
// fees stay unknown and are not filled with zero. GPU count is not a multiplier.

const UNKNOWN = {
  known: false,
  amount: null,
  currency: null,
  period: null,
  unit: null,
  evidence: 'Not promoted to an all-in price. Vast search in the official hello-world is an authenticated POST, and inet_up_cost / inet_down_cost are per-GB rates that need a usage figure. Missing usage is not zero.',
};

export function vastSnapshotOffers(snapshot, { sourceUrl, collectedAt, expiresAt }) {
  const rows = Array.isArray(snapshot?.offers) ? snapshot.offers : [];
  return {
    offers: rows.map(row => ({
      id: `vast:${row?.id}`,
      marketplace: 'vast',
      sourceUrl,
      collectedAt,
      expiresAt,
      available: row?.rentable === true && row?.rented === false ? true : (row?.rentable === false || row?.rented === true ? false : null),
      availabilityEvidence: row?.rentable === true && row?.rented === false
        ? 'imported snapshot rentable=true and rented=false; not a live re-check'
        : '',
      gpu: {
        count: Number.isInteger(row?.num_gpus) && row.num_gpus >= 1 ? row.num_gpus : null,
        model: typeof row?.gpu_name === 'string' ? row.gpu_name : null,
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
        amount: typeof row?.dph_total === 'number' ? row.dph_total : null,
        quoteCurrency: null,
        paymentCurrency: null,
        period: null,
        periodEvidence: '',
        billingUnitConflict: false,
        feesComplete: false,
        feesCompleteEvidence: '',
        components: {
          compute: { ...UNKNOWN },
          storage: { ...UNKNOWN },
          bandwidth: { ...UNKNOWN },
          platformFee: { ...UNKNOWN },
        },
      },
      benchmarks: [],
      ops: {
        migrationDownload: { status: 'unknown' },
        overlapRent: { status: 'unknown' },
        drain: { status: 'unknown' },
        stability: { status: 'unknown' },
        leaseCooldown: { status: 'unknown' },
      },
      raw: {
        dphTotal: typeof row?.dph_total === 'number' ? row.dph_total : null,
        storageCost: row?.storage_cost ?? null,
        inetUpCost: row?.inet_up_cost ?? null,
        inetDownCost: row?.inet_down_cost ?? null,
        numGpus: row?.num_gpus ?? null,
        gpuRam: row?.gpu_ram ?? null,
      },
    })),
    note: 'Raw Vast numbers are not an all-in hourly USD price and are not multiplied by num_gpus.',
  };
}
