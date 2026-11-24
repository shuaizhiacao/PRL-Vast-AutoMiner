import fs from 'node:fs';
import path from 'node:path';
import { Stop } from './errors.js';

let readyPromise;

async function wasmReady() {
  if (!readyPromise) {
    const { cryptoWaitReady } = await import('@polkadot/util-crypto');
    readyPromise = cryptoWaitReady();
  }
  await readyPromise;
}

async function keyring() {
  await wasmReady();
  const { Keyring } = await import('@polkadot/keyring');
  // sponsor-request.mjs：new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromUri(文件内容)
  return new Keyring({ type: 'sr25519', ss58Format: 42 });
}

export function readPublicAddress(file) {
  if (!file) return '';
  if (!fs.existsSync(file)) throw new Stop('矿工地址文件不存在');
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{46,50}$/.test(text)) throw new Stop('矿工地址文件必须只有一个 ss58 地址');
  return text;
}

export function assertMode600(file) {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Stop('密钥路径不是普通文件', 'KEY_MODE');
  const mode = st.mode & 0o777;
  if (mode !== 0o600) {
    throw new Stop(`密钥文件权限必须是 0600，当前是 ${mode.toString(8).padStart(3, '0')}`, 'KEY_MODE');
  }
}

// 只接受官方 sponsor.sh 会读的单行 URI。JSON 钥匙包会在错误信息里泄露字段，直接拒绝且不回显内容。
export function readSigner(file) {
  assertMode600(file);
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
  if (lines.length !== 1) throw new Stop('密钥文件必须只有一行');
  const secret = lines[0].trim();
  if (secret.startsWith('{') || secret.startsWith('[')) throw new Stop('不要把 miner-key.json 直接当作 signer，请使用单行短语或 URI');
  if (secret.length < 8) throw new Stop('密钥文件内容过短');
  return secret;
}

export async function withPair(file, fn) {
  const secret = readSigner(file);
  const ring = await keyring();
  let pair;
  try { pair = ring.addFromUri(secret); }
  catch { throw new Stop('密钥不能按官方 sr25519 / ss58Format 42 的 addFromUri 解析'); }
  return fn(pair);
}

export async function addressFromSigner(file) {
  return withPair(file, pair => pair.address);
}

export async function createSignerFile(file) {
  if (fs.existsSync(file)) throw new Stop('目标文件已存在，拒绝覆盖');
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  await wasmReady();
  const { mnemonicGenerate } = await import('@polkadot/util-crypto');
  const phrase = mnemonicGenerate();
  fs.writeFileSync(file, `${phrase}\n`, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(file, 0o600);
  assertMode600(file);
  const ring = await keyring();
  const pair = ring.addFromUri(phrase);
  return { address: pair.address, file };
}

export async function signEncoded(file, messageBytes) {
  const { signatureVerify } = await import('@polkadot/util-crypto');
  return withPair(file, pair => {
    const signature = `0x${Buffer.from(pair.sign(messageBytes)).toString('hex')}`;
    const valid = signatureVerify(messageBytes, signature, pair.address).isValid === true;
    return { address: pair.address, signature, valid };
  });
}
