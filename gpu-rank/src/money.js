import { finite, httpsUrl, isIsoZ } from './schema.js';

const COMPONENT_KEYS = ['compute', 'storage', 'bandwidth', 'platformFee'];

// Calendar day → 24 hours is applied only after the input explicitly says period=day
// and supplies periodEvidence. It is not a GPU performance coefficient.
// USD-Blockchain, USDT, USDC and CLORE-Blockchain are not treated as USD.
export function quoteAllIn(quote, { fx, asOfMs }) {
  const pending = [];
  const rejected = [];
  const notes = [];
  if (!quote || typeof quote !== 'object') {
    pending.push('price_unit_unknown');
    return { ok: false, pending, rejected, notes, allInUsdPerHour: null };
  }
  const headline = finite(quote.amount);
  if (headline == null) rejected.push('quote_amount_invalid');
  else if (headline <= 0) rejected.push('non_positive_quote');
  if (quote.priceUnit === 'per_gpu') pending.push('price_unit_per_gpu');
  else if (quote.priceUnit !== 'whole_machine') pending.push('price_unit_unknown');
  if (typeof quote.quoteCurrency !== 'string' || typeof quote.paymentCurrency !== 'string' || !quote.quoteCurrency || !quote.paymentCurrency) {
    pending.push('quote_payment_currency_mismatch');
  } else if (quote.quoteCurrency !== quote.paymentCurrency) {
    pending.push('quote_payment_currency_mismatch');
    notes.push('quote currency is not converted into the payment currency');
  }
  if (quote.billingUnitConflict === true || (Array.isArray(quote.documentationConflicts) && quote.documentationConflicts.length > 0)) {
    pending.push('billing_unit_conflict');
  }
  const hours = periodHours(quote, pending);
  const parts = componentSum(quote, pending, rejected);
  if (quote.feesComplete !== true || typeof quote.feesCompleteEvidence !== 'string' || !quote.feesCompleteEvidence.trim()) {
    pending.push('fee_schedule_incomplete');
  }
  if (parts != null && headline != null && Math.abs(headline - parts) > 1e-6) {
    if (typeof quote.headlineDifferenceEvidence !== 'string' || !quote.headlineDifferenceEvidence.trim()) {
      pending.push('headline_components_mismatch');
    } else notes.push('headline_differs_from_components');
  }
  const rate = usdRate(quote.paymentCurrency, fx, asOfMs, pending);
  if (pending.length || rejected.length || hours == null || parts == null || rate == null) {
    return { ok: false, pending, rejected, notes, allInUsdPerHour: null, hours, paymentPerPeriod: parts, usdPerPayment: rate };
  }
  const allInUsdPerHour = (parts / hours) * rate;
  if (!(allInUsdPerHour > 0) || !Number.isFinite(allInUsdPerHour)) {
    pending.push('all_in_not_positive');
    return { ok: false, pending, rejected, notes, allInUsdPerHour: null };
  }
  return { ok: true, pending, rejected, notes, allInUsdPerHour, hours, paymentPerPeriod: parts, usdPerPayment: rate };
}

function periodHours(quote, pending) {
  const evidence = typeof quote.periodEvidence === 'string' && quote.periodEvidence.trim();
  if (!evidence) {
    pending.push('billing_period_unknown');
    return null;
  }
  if (quote.period === 'hour') return 1;
  if (quote.period === 'day') return 24;
  if (quote.period === 'explicit') {
    const h = finite(quote.periodHours);
    if (h != null && h > 0) return h;
  }
  pending.push('billing_period_unknown');
  return null;
}

function componentSum(quote, pending, rejected) {
  const comps = quote.components;
  if (!comps || typeof comps !== 'object') {
    pending.push('component_missing');
    return null;
  }
  let sum = 0;
  let bad = false;
  for (const key of COMPONENT_KEYS) {
    const part = readComponent(comps[key], quote, key, pending, rejected);
    if (part == null) bad = true;
    else sum += part;
  }
  return bad ? null : sum;
}

function readComponent(c, quote, key, pending, rejected) {
  if (!c || typeof c !== 'object') {
    pending.push('component_missing');
    return null;
  }
  if (c.known !== true) {
    pending.push('component_unknown');
    return null;
  }
  const amount = finite(c.amount);
  if (amount == null || amount < 0) {
    rejected.push('component_amount_invalid');
    return null;
  }
  if (key === 'compute' && !(amount > 0)) pending.push('compute_not_positive');
  if (c.currency !== quote.paymentCurrency) pending.push('component_currency_mismatch');
  if (c.period !== quote.period) pending.push('component_period_mismatch');
  if (c.unit !== 'whole_machine') pending.push('component_unit_not_whole_machine');
  if (typeof c.evidence !== 'string' || !c.evidence.trim()) pending.push('component_evidence_missing');
  if (c.known === true && (amount == null || c.currency !== quote.paymentCurrency || c.period !== quote.period || c.unit !== 'whole_machine' || typeof c.evidence !== 'string' || !c.evidence.trim())) {
    return null;
  }
  if (key === 'compute' && !(amount > 0)) return null;
  return amount;
}

function usdRate(currency, fx, asOfMs, pending) {
  if (currency === 'USD') return 1;
  if (typeof currency !== 'string' || !currency) {
    pending.push('fx_missing');
    return null;
  }
  const rows = (fx || []).filter(row => row && row.base === currency && row.quote === 'USD');
  if (!rows.length) {
    pending.push('fx_missing');
    return null;
  }
  const usable = [];
  let expired = false;
  let future = false;
  let invalid = false;
  for (const row of rows) {
    if (!(finite(row.rate) > 0) || !httpsUrl(row.sourceUrl) || !isIsoZ(row.asOf) || !isIsoZ(row.expiresAt)) {
      invalid = true;
      continue;
    }
    const asOf = Date.parse(row.asOf);
    const exp = Date.parse(row.expiresAt);
    if (asOf > asOfMs) future = true;
    else if (exp <= asOfMs) expired = true;
    else usable.push(row);
  }
  if (usable.length > 1) {
    pending.push('fx_ambiguous');
    return null;
  }
  if (usable.length === 1) return usable[0].rate;
  if (future) pending.push('fx_from_future');
  else if (expired) pending.push('fx_expired');
  else if (invalid) pending.push('fx_invalid');
  else pending.push('fx_missing');
  return null;
}

export { COMPONENT_KEYS };
