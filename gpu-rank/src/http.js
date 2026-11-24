import { allowedPublicUrl } from './allowlist.js';

const HEADER_ALLOW = ['content-type', 'date', 'etag', 'last-modified'];
const BODY_CAP = 8_000_000;

// GET only. No caller-supplied method, header, or URL outside the fixed allowlist.
// Environment variables are not read. No credential header is set.
export async function publicGet(url, { fetchImpl = globalThis.fetch } = {}) {
  const allowed = allowedPublicUrl(url);
  if (!allowed) {
    const error = new Error('url is not an allowlisted read-only GET');
    error.code = 'url_not_allowlisted';
    throw error;
  }
  const response = await fetchImpl(allowed, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      accept: 'application/json, text/html, text/plain, */*',
      'user-agent': 'gpu-rank-readonly/0.1',
    },
  });
  const headers = {};
  if (response.headers && typeof response.headers.forEach === 'function') {
    response.headers.forEach((value, key) => {
      if (HEADER_ALLOW.includes(String(key).toLowerCase())) headers[String(key).toLowerCase()] = value;
    });
  }
  const text = typeof response.text === 'function' ? await response.text() : '';
  const truncated = text.length > BODY_CAP;
  return {
    url: allowed,
    method: 'GET',
    status: response.status,
    followedRedirect: false,
    location: headerOne(response.headers, 'location'),
    headers,
    truncated,
    bytes: text.length,
    body: truncated ? text.slice(0, BODY_CAP) : text,
  };
}

function headerOne(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return null;
}
