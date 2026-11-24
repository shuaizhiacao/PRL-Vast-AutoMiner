import fs from 'node:fs';
import path from 'node:path';
import { SEAT_TTL_MS } from './time.js';

export function writeSeatIntent(dir, seat, nowMs, ttlMs = SEAT_TTL_MS) {
  fs.mkdirSync(dir, { recursive: true });
  const body = {
    ok: true,
    at: nowMs,
    expiresAt: nowMs + ttlMs,
    graceHours: seat.graceHours,
    snapshot: seat.snapshot,
  };
  const dest = path.join(dir, 'seat-intent.json');
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body));
  fs.renameSync(tmp, dest);
  return body;
}

export function readSeatIntent(dir, nowMs) {
  const dest = path.join(dir, 'seat-intent.json');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(dest, 'utf8')); }
  catch { return { ok: false, reason: 'missing' }; }
  if (!raw || raw.ok !== true || typeof raw.expiresAt !== 'number') return { ok: false, reason: 'bad' };
  if (nowMs >= raw.expiresAt) return { ok: false, reason: 'expired', intent: raw };
  return { ok: true, intent: raw };
}
