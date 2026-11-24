import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

export const ADDRESS = '5DZsAQuavUAM7A6XvoTkDQgtQdRCMcALdUd6Bx4FSoFMF8ux';

export function readFixture(name) {
  return JSON.parse(fs.readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)));
}

export function clock(start = Date.UTC(2026, 10, 24, 12, 0, 0)) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
  };
}

export function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const call = {
      url: String(url),
      method: opts?.method || 'GET',
      body: opts?.body ? JSON.parse(opts.body) : undefined,
    };
    calls.push(call);
    const res = await handler(call, calls);
    return new Response(JSON.stringify(res?.body ?? {}), {
      status: res?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flop-sponsor-'));
}

export function testConfig(dir, extra = {}) {
  const cfg = loadConfig();
  cfg.stateDir = dir;
  cfg.addressFile = path.join(dir, 'miner.address');
  if (!fs.existsSync(cfg.addressFile)) fs.writeFileSync(cfg.addressFile, `${ADDRESS}\n`);
  cfg.clore = { ...cfg.clore, image: 'example/flop-backend:test', autoRenew: false };
  cfg.modelProfile = '8b';
  return { ...cfg, ...extra, clore: { ...cfg.clore, ...(extra.clore || {}) }, review: { ...cfg.review, ...(extra.review || {}) } };
}

export function serverGood() {
  return {
    id: 6,
    rented: false,
    price: { on_demand: { 'CLORE-Blockchain': 1 } },
    specs: { gpuram: 24, disk: 'NVMe disk 400GB', gpu: '1x RTX 4090' },
  };
}

export function orderGood(ct) {
  return {
    id: 38,
    si: 6,
    ct,
    expired: false,
    pub_cluster: ['n1.c1.clorecloud.net'],
    tcp_ports: ['22:10000'],
  };
}
