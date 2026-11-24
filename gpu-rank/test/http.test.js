import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PUBLIC_GETS } from '../src/allowlist.js';
import { fetchPublicSnapshots } from '../src/fetch-public.js';
import { publicGet } from '../src/http.js';

function mockFetch(status, body, extraHeaders = {}) {
  const calls = [];
  const headers = new Map(Object.entries({ 'content-type': 'application/json', ...extraHeaders }));
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      headers: { get: (name) => headers.get(name) || null, forEach: (fn) => headers.forEach((v, k) => fn(v, k)) },
      text: async () => body,
    };
  };
  return { fetchImpl, calls };
}

test('public GET sends no auth header and refuses order URLs before fetch', async () => {
  const { fetchImpl, calls } = mockFetch(401, '{"error":"unauthorized"}');
  const ok = await publicGet('https://api.clore.ai/v1/marketplace', { fetchImpl });
  assert.equal(ok.method, 'GET');
  assert.equal(ok.status, 401);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.deepEqual(Object.keys(calls[0].init.headers).sort(), ['accept', 'user-agent']);
  assert.equal(JSON.stringify(calls[0].init).includes('auth'), false);
  await assert.rejects(() => publicGet('https://api.clore.ai/v1/create_order', { fetchImpl }), /allowlisted/);
  await assert.rejects(() => publicGet('https://console.vast.ai/api/v0/bundles/', { fetchImpl }), /allowlisted/);
  await assert.rejects(() => publicGet('http://api.clore.ai/v1/marketplace', { fetchImpl }), /allowlisted/);
  assert.equal(calls.length, 1);
});

test('redirects are not followed', async () => {
  const { fetchImpl, calls } = mockFetch(302, '', { location: 'https://example.invalid/steal' });
  const result = await publicGet('https://docs.vast.ai/api-reference/hello-world', { fetchImpl });
  assert.equal(result.followedRedirect, false);
  assert.equal(result.location, 'https://example.invalid/steal');
  assert.equal(calls.length, 1);
});

test('fetch-public records an unauthorized marketplace without ranking it', async () => {
  const { fetchImpl } = mockFetch(401, '{"code":1}');
  const out = mkdtempSync(path.join(tmpdir(), 'gpu-rank-fetch-'));
  const manifest = await fetchPublicSnapshots(out, { fetchImpl, now: new Date('2026-11-24T12:00:00.000Z') });
  assert.equal(manifest.optimalMachineSelected, false);
  assert.equal(manifest.authHeadersSent, false);
  assert.equal(manifest.keysRead, false);
  assert.ok(manifest.gaps.some(gap => gap.includes('HTTP 401')));
  assert.ok(manifest.results.every(item => item.method === 'GET'));
  assert.equal(manifest.results.find(item => item.id === 'clore-marketplace').normalized, null);
});

test('a marketplace 200 is summarized and not embedded as rankable offers', async () => {
  const body = JSON.stringify({
    code: 0,
    servers: [{
      id: 1,
      rented: false,
      price: { on_demand: { 'CLORE-Blockchain': 10, 'USD-Blockchain': 1 }, usd: { on_demand_clore: 1 } },
      gpu_array: ['EXAMPLE GPU'],
    }],
  });
  const { fetchImpl } = mockFetch(200, body);
  const out = mkdtempSync(path.join(tmpdir(), 'gpu-rank-fetch200-'));
  const manifest = await fetchPublicSnapshots(out, { fetchImpl, now: new Date('2026-11-24T12:00:00.000Z') });
  const market = manifest.results.find(item => item.id === 'clore-marketplace');
  assert.equal(market.normalized.summary.offerCount, 2);
  assert.equal(market.normalized.summary.ranked, false);
  assert.equal(market.normalized.summary.feesCompleteTrue, 0);
  assert.equal(market.normalized.summary.billingUnitConflict, 0);
  assert.equal(Object.hasOwn(market.normalized, 'offers'), false);
  assert.equal(manifest.optimalMachineSelected, false);
});

test('allowlist has no write paths', () => {
  for (const item of PUBLIC_GETS) {
    assert.equal(item.url.startsWith('https://'), true);
    assert.equal(/create_order|cancel|register|sponsor|payment|worker/i.test(item.url), false);
  }
});
