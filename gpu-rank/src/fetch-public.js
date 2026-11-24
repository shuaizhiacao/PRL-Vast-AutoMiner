import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PUBLIC_GETS } from './allowlist.js';
import { cloreMarketplaceOffers } from './adapters/clore.js';
import { publicGet } from './http.js';

export async function fetchPublicSnapshots(outDir, { fetchImpl, now = new Date() } = {}) {
  await mkdir(outDir, { recursive: true });
  const collectedAt = now.toISOString();
  const results = [];
  for (const target of PUBLIC_GETS) {
    const item = { id: target.id, url: target.url, role: target.role, note: target.note, method: 'GET' };
    try {
      const response = await publicGet(target.url, { fetchImpl });
      const sha256 = createHash('sha256').update(response.body).digest('hex');
      const file = path.join(outDir, `${target.id}.body`);
      await writeFile(file, response.body);
      item.status = response.status;
      item.bytes = response.bytes;
      item.truncated = response.truncated;
      item.sha256 = sha256;
      item.followedRedirect = false;
      item.location = response.location;
      item.headers = response.headers;
      item.file = file;
      if (target.id === 'clore-marketplace' && response.status === 200 && !response.truncated) {
        item.normalized = normalizeMarketplace(response.body, target.url, collectedAt);
        item.gap = item.normalized.gap;
      } else if (target.id === 'clore-marketplace') {
        item.normalized = null;
        item.gap = `marketplace GET returned HTTP ${response.status}. No key was sent. Offers were not ranked.`;
      }
    } catch (error) {
      item.status = null;
      item.error = error.code || error.message;
      item.gap = `GET failed: ${error.message}`;
    }
    results.push(item);
  }
  const manifest = {
    schemaVersion: 'gpu-rank.fetch.v1',
    collectedAt,
    optimalMachineSelected: false,
    rankedIsMarketOptimum: false,
    authHeadersSent: false,
    keysRead: false,
    methods: ['GET'],
    vastOfferSearch: 'not called; official docs show POST /api/v0/bundles/ with a bearer credential',
    results,
    gaps: results.flatMap(item => item.gap ? [`${item.id}: ${item.gap}`] : []),
    disclaimer: 'These bodies are source snapshots. Example fixtures are not in this directory. Nothing here is an optimal-machine ranking.',
  };
  if (!manifest.gaps.length) {
    manifest.gaps.push('No same-condition H100 benchmark was supplied with the public payload, so no candidate is ranked.');
  }
  manifest.gaps.push('Clore on_demand period conflicts across official pages, so normalized quotes keep billingUnitConflict=true.');
  manifest.gaps.push('renter_fees and creation_fees were not fetched because that documented GET requires an auth header.');
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

function normalizeMarketplace(body, sourceUrl, collectedAt) {
  let payload;
  try { payload = JSON.parse(body); } catch {
    return { parsed: false, offers: [], gap: 'marketplace body was not JSON' };
  }
  const normalized = cloreMarketplaceOffers(payload, {
    sourceUrl,
    collectedAt,
    expiresAt: null,
  });
  return {
    parsed: true,
    note: normalized.note,
    summary: normalized.summary,
    ranked: false,
    gap: 'Normalized quotes have no same-condition benchmark and a billing-unit conflict. They are not ranked.',
  };
}
