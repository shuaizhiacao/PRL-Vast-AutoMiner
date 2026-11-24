#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, executionMode } from './src/config.js';
import { verifyGenesis } from './src/genesis.js';
import { createSignerFile } from './src/keys.js';
import { signDryResult } from './src/sign.js';
import { runOnce } from './src/orchestrator.js';
import { pollDelayMs } from './src/time.js';
import { acquireProcessLock } from './src/lock.js';
import { loadOrCreateSshKey, sshExec } from './src/ssh.js';
import { Stop } from './src/errors.js';

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || (s => process.stdout.write(s));
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'run';
  const cfg = loadConfig(arg(argv, '--config') || io.defaultConfig || '');
  if (cmd === 'keygen') {
    const out = arg(argv, '--out');
    if (!out) throw new Stop('keygen 需要 --out');
    const created = await createSignerFile(out);
    stdout(`address=${created.address}\nfile=${created.file}\n`);
    return 0;
  }
  if (cmd === 'sign-dry') {
    const signer = arg(argv, '--signer') || cfg.signerFile;
    if (!signer) throw new Stop('sign-dry 需要 --signer');
    const hash = await verifyGenesis({
      expected: cfg.genesisHash,
      url: cfg.rpcUrl,
      fetchHash: io.fetchHash,
    });
    const result = await signDryResult({
      signerFile: signer,
      genesis: hash,
      issuedAt: String(io.now ? io.now() : Date.now()),
      genesisVerified: true,
    });
    stdout(`address=${result.address}\nmessage=${result.message}\nverify=${result.valid ? 'pass' : 'fail'}\n`);
    return result.valid ? 0 : 2;
  }
  if (cmd !== 'run') throw new Stop(`未知子命令：${cmd}`);

  const env = io.env || process.env;
  const mode = executionMode(cfg, env);
  let genesis = null;
  let genesisVerified = false;
  try {
    genesis = await verifyGenesis({ expected: cfg.genesisHash, url: cfg.rpcUrl, fetchHash: io.fetchHash });
    genesisVerified = true;
    stdout(`genesis=${genesis}\n`);
  } catch (e) {
    stdout(`genesis 未通过：${e.message}\n`);
    if (mode === 'live') return 2;
  }

  const stateDir = path.resolve(cfg.stateDir);
  const release = acquireProcessLock(stateDir);
  const now = io.now || Date.now;
  const sleep = io.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  try {
    let privateKeyPath = '';
    const sshKeys = async () => {
      const key = await loadOrCreateSshKey(stateDir);
      privateKeyPath = key.privatePath;
      return key;
    };
    const ssh = endpoint => sshExec({ privateKeyPath, endpoint });
    const once = argv.includes('--once');
    for (;;) {
      const result = await runOnce({
        cfg, env, fetchImpl: io.fetchImpl || globalThis.fetch, now, sleep, stateDir,
        genesis, genesisVerified, sshKeys, ssh: io.ssh || ssh, spawn: io.spawn,
      });
      for (const line of result.logs || []) stdout(`${line}\n`);
      if (result.preview?.backend) {
        for (const step of result.preview.backend) stdout(`backend:${step.id}:${step.text}\n`);
      }
      stdout(`phase=${result.phase}\n`);
      if (result.waitReason) stdout(`wait=${result.waitReason}\n`);
      if (result.dry || result.stopped || result.waitingApproval || once) return result.stopped ? 2 : 0;
      if (result.phase === 'FAILED') return 2;
      if (result.phase === 'READY' || result.phase === 'CALIBRATE') return 0;
      const delay = result.waitUntil != null ? Math.max(0, result.waitUntil - now()) : pollDelayMs(io.rng || Math.random, cfg);
      stdout(`waitMs=${delay}\n`);
      await sleep(delay);
    }
  } finally {
    release();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then(code => process.exit(code || 0)).catch(e => {
    process.stderr.write(`${e?.message || e}\n`);
    process.exit(e?.code === 'LIVE_REFUSED' ? 3 : 2);
  });
}
