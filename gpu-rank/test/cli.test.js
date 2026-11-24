import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { comparableDocument, edgesDocument } from '../fixtures/factory.js';
import { writeFileSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'cli.js');

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('CLI rank writes JSON, CSV, and text for the example fixture', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gpu-rank-'));
  const input = path.join(dir, 'in.json');
  const out = path.join(dir, 'out');
  writeFileSync(input, JSON.stringify(comparableDocument()));
  const result = run(['rank', '--input', input, '--out', out]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.equal(report.optimalMachineSelected, false);
  assert.equal(report.dataset.kind, 'example');
  assert.deepEqual(report.groups.find(g => g.baseline.id === 'h100-sxm-80-hbm3').rows.map(r => r.offerId), ['ex-clore', 'ex-a', 'ex-b']);
  const text = readFileSync(path.join(out, 'report.txt'), 'utf8');
  assert.match(text, /EXAMPLE DATA/);
  assert.match(text, /没有筛出最优机器/);
  const csv = readFileSync(path.join(out, 'report.csv'), 'utf8');
  assert.match(csv, /^status,board,groupKey,/);
  assert.match(csv, /ex-clore/);
  assert.match(result.stdout, /EXAMPLE DATA/);
});

test('CLI edges fixture ranks nobody', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gpu-rank-'));
  const input = path.join(dir, 'edges.json');
  const out = path.join(dir, 'out');
  writeFileSync(input, JSON.stringify(edgesDocument()));
  const result = run(['rank', '--input', input, '--out', out, '--include-theoretical']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.equal(report.groups.length, 0);
  assert.equal(report.optimalMachineSelected, false);
  assert.equal(report.theoreticalBoards[0].rows[0].offerId, 'ex-theory');
  assert.match(readFileSync(path.join(out, 'report.txt'), 'utf8'), /理论代理榜/);
});

test('banned flags and invalid documents fail closed', () => {
  const banned = run(['rank', '--order', 'create']);
  assert.equal(banned.status, 2);
  assert.match(banned.stderr, /read-only/);
  const dir = mkdtempSync(path.join(tmpdir(), 'gpu-rank-'));
  const input = path.join(dir, 'bad.json');
  writeFileSync(input, JSON.stringify({ schemaVersion: 'nope' }));
  const bad = run(['validate', '--input', input]);
  assert.equal(bad.status, 2);
  const help = run(['help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /fetch-public/);
});
