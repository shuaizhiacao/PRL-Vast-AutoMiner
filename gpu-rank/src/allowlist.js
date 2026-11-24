// Fixed read-only GETs. The CLI does not accept a caller-supplied URL.
// Vast offer search is not listed: the official hello-world uses POST
// https://console.vast.ai/api/v0/bundles/ with a bearer credential.
export const PUBLIC_GETS = [
  {
    id: 'clore-marketplace',
    url: 'https://api.clore.ai/v1/marketplace',
    role: 'market',
    note: 'Documented GET. The host API marks the auth header mandatory. This client sends no auth header and no key.',
  },
  {
    id: 'clore-host-api-doc',
    url: 'https://docs.clore.ai/for-hosts/api',
    role: 'documentation',
    note: 'Host API: price.on_demand is an on-demand price per day. renter_fees and creation_fees are separate.',
  },
  {
    id: 'clore-dev-api-reference',
    url: 'https://docs.clore.ai/dev/reference/api-reference',
    role: 'documentation',
    note: 'Developer reference. Checked for conflicts with the host API period and currency fields.',
  },
  {
    id: 'clore-client-reference',
    url: 'https://docs.clore.ai/dev/reference/clore-client',
    role: 'documentation',
    note: 'Client reference describes price.usd.on_demand_clore as USD per hour. That field is not used.',
  },
  {
    id: 'vast-hello-world-doc',
    url: 'https://docs.vast.ai/api-reference/hello-world',
    role: 'documentation',
    note: 'Official lifecycle page. Search is POST with a bearer key. This client does not call it.',
  },
];

const ALLOWED = new Set(PUBLIC_GETS.map(item => item.url));

export function allowedPublicUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
  const normalized = u.toString().replace(/\/$/, '');
  const match = [...ALLOWED].find(item => item.replace(/\/$/, '') === normalized);
  return match || null;
}
