import { Invariant, Stop } from './errors.js';
import { addressFromSigner, signEncoded } from './keys.js';

// 与官方 sponsor-request.mjs 的字节一致：
// flop-sponsor/v1|${role}|${genesis}|${address}|${issuedAt}
// issuedAt 是 String(Date.now())，单位毫秒。
export function sponsorMessage({ genesis, address, issuedAt, role = 'miner' }) {
  if (role !== 'miner') throw new Stop('本编排器只签 miner，不签 validator');
  return `flop-sponsor/v1|${role}|${genesis}|${address}|${issuedAt}`;
}

export function sponsorBodyShape(address) {
  return {
    address: address || '<未配置矿工地址>',
    issuedAt: '<毫秒时间戳字符串>',
    signature: '<不在 DRY 生成，也不写入日志>',
  };
}

export async function signSponsor({ signerFile, genesis, issuedAt, genesisVerified }) {
  if (genesisVerified !== true) throw new Invariant('未校验 genesis 不签');
  // 先取地址再组消息，只对最终赞助字符串签一次。
  const address = await addressFromSigner(signerFile);
  const text = sponsorMessage({ genesis, address, issuedAt });
  const signed = await signEncoded(signerFile, new TextEncoder().encode(text));
  if (signed.address !== address) throw new Stop('同一密钥两次推导的地址不一致');
  if (!signed.valid) throw new Stop('本地验签失败，拒绝提交');
  return { address, message: text, issuedAt, signature: signed.signature, valid: true };
}

// 供 sign-dry 使用：只返回可打印字段。签名留在闭包里完成验签，不出现在返回值中。
export async function signDryResult({ signerFile, genesis, issuedAt, genesisVerified }) {
  const signed = await signSponsor({ signerFile, genesis, issuedAt, genesisVerified });
  return { address: signed.address, message: signed.message, valid: signed.valid === true };
}

export async function signForSubmit(opts) {
  return signSponsor(opts);
}
