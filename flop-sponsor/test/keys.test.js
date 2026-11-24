import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../index.js';
import { createSignerFile, readSigner } from '../src/keys.js';
import { signDryResult } from '../src/sign.js';
import { DEVNET_GENESIS } from '../src/config.js';
import { Stop } from '../src/errors.js';
import { tempDir } from './helpers.js';

test('keygen 写出 0600 文件，标准输出没有私钥', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'signer');
  let out = '';
  const code = await main(['keygen', '--out', file], { stdout: s => { out += s; } });
  assert.equal(code, 0);
  const phrase = fs.readFileSync(file, 'utf8').trim();
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  assert.equal(phrase.split(/\s+/).length >= 12, true);
  assert.equal(out.includes(phrase.split(/\s+/)[0]), false);
  assert.match(out, /address=5/);
});

test('sign-dry 核对创世哈希后只打印消息和验签结果，不 POST', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'signer');
  await createSignerFile(file);
  const posts = [];
  let out = '';
  const code = await main(['sign-dry', '--signer', file], {
    stdout: s => { out += s; },
    fetchHash: async () => DEVNET_GENESIS,
    fetchImpl: async (url, opts) => { posts.push(opts?.method || 'GET'); return new Response('{}'); },
  });
  assert.equal(code, 0);
  assert.match(out, new RegExp(`message=flop-sponsor/v1\\|miner\\|${DEVNET_GENESIS}\\|5`));
  assert.match(out, /verify=pass/);
  assert.equal(/0x[0-9a-f]{128,}/i.test(out), false);
  assert.equal(posts.length, 0);
  const phrase = fs.readFileSync(file, 'utf8').trim().split(/\s+/)[0];
  assert.equal(out.includes(phrase), false);
});

test('权限不是 0600 时拒绝读取密钥', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'signer');
  await createSignerFile(file);
  fs.chmodSync(file, 0o644);
  assert.throws(() => readSigner(file), Stop);
  await assert.rejects(
    () => signDryResult({ signerFile: file, genesis: DEVNET_GENESIS, issuedAt: '1', genesisVerified: true }),
    /0600/,
  );
});
