import { createHash } from 'node:crypto';
import { allowedPublicUrl } from './allowlist.js';

const HEADER_ALLOW = ['content-type', 'date', 'etag', 'last-modified'];
export const BODY_CAP = 8_000_000;
export const REQUEST_TIMEOUT_MS = 20_000;

// GET only. No caller-supplied method, header, or URL outside the fixed allowlist.
// Environment variables are not read. No credential header is set.
// The body is counted in bytes and aborted at BODY_CAP. timeoutMs covers the
// response and the read. A timeout or cap on one call does not start another URL.
export async function publicGet(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  byteCap = BODY_CAP,
} = {}) {
  const allowed = allowedPublicUrl(url);
  if (!allowed) {
    const error = new Error('url is not an allowlisted read-only GET');
    error.code = 'url_not_allowlisted';
    throw error;
  }
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error('public GET timed out');
      error.code = 'timeout';
      reject(error);
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchImpl(allowed, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'application/json, text/html, text/plain, */*',
          'user-agent': 'gpu-rank-readonly/0.1',
        },
      }),
      timeout,
    ]);
    const read = await Promise.race([
      readCapped(response, byteCap, controller),
      timeout,
    ]);
    return {
      url: allowed,
      method: 'GET',
      status: response.status,
      followedRedirect: false,
      location: headerOne(response.headers, 'location'),
      headers: pickHeaders(response.headers),
      truncated: read.truncated,
      bytes: read.bytes,
      sha256: read.sha256,
      body: read.body,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response, byteCap, controller) {
  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    try {
      while (true) {
        const step = await reader.read();
        if (step.done) break;
        const value = step.value;
        const size = value?.byteLength || 0;
        if (bytes + size > byteCap) {
          truncated = true;
          controller.abort();
          try { await reader.cancel(); } catch { /* already aborted */ }
          break;
        }
        bytes += size;
        chunks.push(Buffer.from(value));
      }
    } finally {
      try { reader.releaseLock(); } catch { /* reader already released */ }
    }
    const buf = Buffer.concat(chunks);
    return { body: buf.toString('utf8'), bytes, truncated, sha256: createHash('sha256').update(buf).digest('hex') };
  }
  const text = typeof response.text === 'function' ? await response.text() : '';
  const buf = Buffer.from(text);
  const truncated = buf.byteLength > byteCap;
  const kept = truncated ? buf.subarray(0, byteCap) : buf;
  return {
    body: kept.toString('utf8'),
    bytes: kept.byteLength,
    truncated,
    sha256: createHash('sha256').update(kept).digest('hex'),
  };
}

function pickHeaders(headers) {
  const out = {};
  if (headers && typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      if (HEADER_ALLOW.includes(String(key).toLowerCase())) out[String(key).toLowerCase()] = value;
    });
  }
  return out;
}

function headerOne(headers, name) {
  if (!headers || typeof headers.get !== 'function') return null;
  return headers.get(name);
}
