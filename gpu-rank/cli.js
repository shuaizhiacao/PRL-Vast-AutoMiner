#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchPublicSnapshots } from './src/fetch-public.js';
import { rankDocument } from './src/rank.js';
import { reportCsv, reportText } from './src/report.js';

const BANNED = ['--live', '--rent', '--order', '--create', '--delete', '--sponsor', '--pay', '--method', '--header', '--auth', '--key'];

const help = `gpu-rank — read-only comparable GPU quote ranking

  node gpu-rank/cli.js rank --input <file.json> [--out <dir>] [--now <ISO-UTC>] [--include-theoretical]
  node gpu-rank/cli.js validate --input <file.json> [--now <ISO-UTC>]
  node gpu-rank/cli.js fetch-public --out <dir>

rank writes report.json, report.csv, and report.txt.
It does not rent, deploy, pay, register, or read API keys.
Example fixtures are marked EXAMPLE and are not a market ranking.
fetch-public sends only the fixed https GET allowlist, with no auth header.
`;

function parseArgs(argv) {
  const flags = new Set();
  const opts = {};
  const position = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (BANNED.includes(arg)) {
      const error = new Error(`${arg} is not available. This CLI is read-only.`);
      error.code = 'banned_flag';
      throw error;
    }
    if (arg === '--include-theoretical') flags.add(arg);
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
      opts[key] = value;
      i += 1;
    } else position.push(arg);
  }
  return { command: position[0] || 'help', flags, opts };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === 'help' || parsed.command === '--help') {
    process.stdout.write(help);
    return;
  }
  if (parsed.command === 'fetch-public') {
    if (!parsed.opts.out) throw new Error('--out is required');
    const manifest = await fetchPublicSnapshots(parsed.opts.out);
    process.stdout.write(`${reportFetch(manifest)}\n`);
    return;
  }
  if (parsed.command !== 'rank' && parsed.command !== 'validate') throw new Error(`unknown command ${parsed.command}`);
  if (!parsed.opts.input) throw new Error('--input is required');
  const raw = await readFile(parsed.opts.input, 'utf8');
  const doc = JSON.parse(raw);
  if (parsed.opts.now) doc.asOf = parsed.opts.now;
  const report = rankDocument(doc, {
    includeTheoretical: parsed.flags.has('--include-theoretical'),
    inputSha256: createHash('sha256').update(raw).digest('hex'),
  });
  if (!report.ok) {
    process.stderr.write(`${report.errors.join('\n')}\n`);
    process.exitCode = 2;
    return;
  }
  if (parsed.command === 'validate') {
    process.stdout.write(`ok offers=${doc.offers.length} ranked=${report.ranked.length} pending=${report.pending.length} excluded=${report.excluded.length} rejected=${report.rejected.length}\n`);
    process.stdout.write('optimalMachineSelected=false\n');
    return;
  }
  const out = parsed.opts.out || path.join(path.dirname(parsed.opts.input), 'out');
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(out, 'report.csv'), reportCsv(report));
  await writeFile(path.join(out, 'report.txt'), reportText(report));
  process.stdout.write(reportText(report));
}

function reportFetch(manifest) {
  const lines = ['public GET snapshots. No ranking was produced from these bodies.', 'optimalMachineSelected=false'];
  for (const item of manifest.results) {
    lines.push(`${item.id} ${item.method} ${item.url} status=${item.status ?? 'error'} ${item.gap || item.note || ''}`);
  }
  for (const gap of manifest.gaps) lines.push(`gap: ${gap}`);
  return lines.join('\n');
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
