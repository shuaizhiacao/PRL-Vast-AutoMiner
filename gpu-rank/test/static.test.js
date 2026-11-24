import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('ranking sources do not read keys, write orders, or invent an H100 coefficient', () => {
  const sources = files(path.join(root, 'src')).concat(path.join(root, 'cli.js'));
  const body = sources.map(file => readFileSync(file, 'utf8')).join('\n');
  assert.equal(/process\.env/.test(body), false);
  assert.equal(/['"]Authorization['"]/.test(body), false);
  assert.equal(/\bAuthorization\b/.test(body), false);
  assert.equal(/method:\s*['"]POST['"]/.test(body), false);
  assert.equal(/method:\s*['"]PUT['"]/.test(body), false);
  assert.equal(/method:\s*['"]DELETE['"]/.test(body), false);
  assert.equal(/hourlyUsd/.test(body), false);
  assert.equal(/vram\s*\/\s*80/.test(body), false);
  assert.equal(/\/\s*80\b/.test(body), false);
  const withoutDenial = body.replaceAll('no yield, airdrop, or profit is estimated', '');
  assert.equal(/airdrop|profitUsd|yieldUsd/.test(withoutDenial), false);
  assert.equal(/from ['"]\.\.\/\.\.\/src\//.test(body), false);
  assert.equal(/flop-sponsor/.test(body), false);
  assert.match(body, /method: 'GET'/);
});
