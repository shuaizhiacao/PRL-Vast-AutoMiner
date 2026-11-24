import fs from 'node:fs';
import path from 'node:path';
import { Stop } from './errors.js';
import { redact } from './redact.js';

export const PHASES = [
  'SEAT_CHECK',
  'SPONSOR_SIGN',
  'SPONSOR_SUBMIT',
  'SPONSORED',
  'RENT_INTENT',
  'RENT_UNKNOWN',
  'RENTED',
  'BOOTSTRAP',
  'CALIBRATE',
  'READY',
  'FAILED',
  'STOP_NEEDS_HUMAN',
];

const NEXT = {
  SEAT_CHECK: ['SPONSOR_SIGN'],
  SPONSOR_SIGN: ['SPONSOR_SUBMIT'],
  SPONSOR_SUBMIT: ['SPONSORED'],
  SPONSORED: ['RENT_INTENT'],
  RENT_INTENT: ['RENT_UNKNOWN', 'SPONSORED'],
  RENT_UNKNOWN: ['RENTED'],
  RENTED: ['BOOTSTRAP'],
  BOOTSTRAP: ['CALIBRATE'],
  CALIBRATE: ['READY'],
  READY: [],
  FAILED: [],
};

export function blankState() {
  return {
    version: 1,
    phase: 'SEAT_CHECK',
    seat: { ok: false },
    sponsor: { done: false },
    rent: {},
    failure: null,
    steps: [],
    history: [],
  };
}

export function canTransition(from, to) {
  if (to === 'FAILED' && from !== 'FAILED' && from !== 'READY' && from !== 'STOP_NEEDS_HUMAN') return true;
  if (to === 'STOP_NEEDS_HUMAN' && from !== 'FAILED' && from !== 'READY' && from !== 'STOP_NEEDS_HUMAN') return true;
  return (NEXT[from] || []).includes(to);
}

export function transition(state, to, patch = {}, now = Date.now(), note = '') {
  if (!canTransition(state.phase, to)) {
    throw new Stop(`非法状态迁移：${state.phase} → ${to}`);
  }
  const history = state.history.concat({
    from: state.phase,
    to,
    at: now,
    note: redact(note).slice(0, 300),
  }).slice(-100);
  return {
    ...state,
    ...patch,
    phase: to,
    history,
  };
}

export function statePath(dir) {
  return path.join(dir, 'state.json');
}

export function loadState(dir) {
  const file = statePath(dir);
  if (!fs.existsSync(file)) return blankState();
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Stop('状态文件损坏，拒绝继续'); }
  if (raw?.version !== 1 || !PHASES.includes(raw.phase)) throw new Stop('状态文件版本或阶段无法识别');
  return raw;
}

export function saveState(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  const file = statePath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
  return state;
}
