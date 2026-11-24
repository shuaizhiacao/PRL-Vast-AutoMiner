export const SCHEMA_INPUT = 'gpu-rank.input.v1';
export const SCHEMA_REPORT = 'gpu-rank.report.v1';
export const OPS_KEYS = ['migrationDownload', 'overlapRent', 'drain', 'stability', 'leaseCooldown'];

const WORKLOAD_KEYS = ['modelId', 'revision', 'precision', 'inputTokens', 'outputTokens', 'batchSize', 'concurrency', 'metric'];

export function finite(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function isIsoZ(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(s)) return false;
  return Number.isFinite(Date.parse(s));
}

export function httpsUrl(s) {
  if (typeof s !== 'string' || s.length < 8 || s.length > 2000) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return u.toString();
}

export function workloadIdentity(w) {
  if (!w || typeof w !== 'object') return null;
  const out = {};
  for (const k of WORKLOAD_KEYS) out[k] = w[k];
  return out;
}

export function sameWorkload(a, b) {
  const left = workloadIdentity(a);
  const right = workloadIdentity(b);
  if (!left || !right) return false;
  return WORKLOAD_KEYS.every(k => left[k] === right[k]);
}

function nonEmpty(s) {
  return typeof s === 'string' && s.trim().length > 0;
}

export function validateStructure(doc) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) err('document must be an object');
  if (!doc || typeof doc !== 'object') return { ok: false, errors };
  if (doc.schemaVersion !== SCHEMA_INPUT) err(`schemaVersion must be ${SCHEMA_INPUT}`);
  const ds = doc.dataset;
  if (!ds || typeof ds !== 'object') err('dataset is required');
  else {
    if (!nonEmpty(ds.id)) err('dataset.id is required');
    if (ds.kind !== 'example' && ds.kind !== 'market-snapshot') err('dataset.kind must be example or market-snapshot');
    if (!nonEmpty(ds.label)) err('dataset.label is required');
    if (ds.kind === 'example' && !String(ds.label).includes('EXAMPLE')) err('example datasets must include EXAMPLE in the label');
    if (ds.kind === 'market-snapshot' && /最优|optimal machine/i.test(ds.label)) err('market snapshots must not be labeled as an optimal pick');
    if (!isIsoZ(ds.collectedAt)) err('dataset.collectedAt must be a UTC ISO timestamp');
    if (!Array.isArray(ds.sourceUrls) || ds.sourceUrls.some(u => !httpsUrl(u))) err('dataset.sourceUrls must be https URLs');
  }
  if (!isIsoZ(doc.asOf)) err('asOf must be a UTC ISO timestamp');
  errors.push(...workloadErrors(doc.workload, 'workload'));
  if (!Array.isArray(doc.baselines)) err('baselines must be an array');
  if (!Array.isArray(doc.offers)) err('offers must be an array');
  if (!Array.isArray(doc.fx)) err('fx must be an array');
  else {
    doc.fx.forEach((fx, i) => errors.push(...fxErrors(fx, `fx[${i}]`)));
  }
  errors.push(...requirementErrors(doc.requirements));
  if (doc.maxAgeSeconds != null) {
    const n = finite(doc.maxAgeSeconds);
    if (n == null || n <= 0) err('maxAgeSeconds must be a positive finite number when set');
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

export function workloadErrors(w, prefix) {
  const errors = [];
  if (!w || typeof w !== 'object') return [`${prefix} is required`];
  for (const k of ['modelId', 'revision', 'precision', 'metric']) {
    if (!nonEmpty(w[k])) errors.push(`${prefix}.${k} must be a non-empty string`);
  }
  if (!Number.isInteger(w.inputTokens) || w.inputTokens < 0) errors.push(`${prefix}.inputTokens must be an integer >= 0`);
  if (!Number.isInteger(w.outputTokens) || w.outputTokens < 1) errors.push(`${prefix}.outputTokens must be an integer >= 1`);
  if (!Number.isInteger(w.batchSize) || w.batchSize < 1) errors.push(`${prefix}.batchSize must be an integer >= 1`);
  if (!Number.isInteger(w.concurrency) || w.concurrency < 1) errors.push(`${prefix}.concurrency must be an integer >= 1`);
  const lat = finite(w.maxLatencyMs);
  if (lat == null || lat <= 0) errors.push(`${prefix}.maxLatencyMs must be a finite number > 0`);
  return errors;
}

function fxErrors(fx, prefix) {
  const errors = [];
  if (!fx || typeof fx !== 'object') return [`${prefix} must be an object`];
  if (!nonEmpty(fx.base) || fx.base === 'USD') errors.push(`${prefix}.base must be a non-USD currency code`);
  if (fx.quote !== 'USD') errors.push(`${prefix}.quote must be USD`);
  if (!(finite(fx.rate) > 0)) errors.push(`${prefix}.rate must be a finite number > 0`);
  if (!httpsUrl(fx.sourceUrl)) errors.push(`${prefix}.sourceUrl must be https`);
  if (!isIsoZ(fx.asOf) || !isIsoZ(fx.expiresAt)) errors.push(`${prefix} timestamps must be UTC ISO`);
  return errors;
}

function requirementErrors(req) {
  const errors = [];
  if (!req || typeof req !== 'object') return ['requirements is required'];
  errors.push(...gateErrors(req.vram, 'requirements.vram', {
    disabled: true,
    min_gb_per_gpu: (g) => finite(g.minGb) > 0,
  }));
  errors.push(...gateErrors(req.backend, 'requirements.backend', {
    disabled: true,
    allowlist: (g) => Array.isArray(g.names) && g.names.length > 0 && g.names.every(nonEmpty),
  }));
  errors.push(...gateErrors(req.network, 'requirements.network', {
    disabled: true,
    min_mbps: (g) => finite(g.downMbps) > 0 && finite(g.upMbps) > 0,
  }));
  errors.push(...gateErrors(req.disk, 'requirements.disk', {
    disabled: true,
    min_gb: (g) => finite(g.minGb) > 0,
  }));
  return errors;
}

function gateErrors(gate, prefix, modes) {
  if (!gate || typeof gate !== 'object') return [`${prefix} is required`];
  const check = modes[gate.mode];
  if (!check) return [`${prefix}.mode is not a known explicit mode`];
  if (gate.mode === 'disabled') {
    return nonEmpty(gate.evidence) ? [] : [`${prefix}.evidence is required when disabled`];
  }
  return check(gate) ? [] : [`${prefix} is incomplete for mode ${gate.mode}`];
}

export function assessBaseline(b, workload, asOfMs) {
  const problems = [];
  if (!b || typeof b !== 'object') return ['baseline is not an object'];
  if (!nonEmpty(b.id)) problems.push('id');
  if (b.gpu?.model !== 'H100') problems.push('gpu.model must be H100');
  if (!nonEmpty(b.gpu?.formFactor)) problems.push('gpu.formFactor');
  if (!(finite(b.gpu?.vramGb) > 0)) problems.push('gpu.vramGb');
  if (!nonEmpty(b.gpu?.memoryGeneration)) problems.push('gpu.memoryGeneration');
  if (!Number.isInteger(b.gpuCount) || b.gpuCount < 1) problems.push('gpuCount');
  if (!(finite(b.throughput) > 0)) problems.push('throughput');
  if (b.throughputScope !== 'whole_machine') problems.push('throughputScope');
  if (b.metric !== workload.metric) problems.push('metric');
  if (!sameWorkload(b.workload, workload)) problems.push('workload');
  if (!(finite(b.latencyMs) >= 0) || b.latencyMs > workload.maxLatencyMs) problems.push('latencyMs');
  if (!httpsUrl(b.sourceUrl)) problems.push('sourceUrl');
  if (!isIsoZ(b.collectedAt) || Date.parse(b.collectedAt) > asOfMs) problems.push('collectedAt');
  if (!nonEmpty(b.evidence)) problems.push('evidence');
  return problems;
}
