import { Stop } from './errors.js';

export function normalizeGenesis(hash) {
  const s = String(hash || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(s)) return null;
  return s;
}

// 官方脚本用 api.genesisHash。这里用公开 RPC 的 chain_getBlockHash(0)，不拉 @polkadot/api。
export function rpcGenesis(url, { timeoutMs = 15_000, WebSocketImpl = globalThis.WebSocket } = {}) {
  if (typeof WebSocketImpl !== 'function') return Promise.reject(new Stop('当前 Node 没有 WebSocket，无法核对创世哈希'));
  return new Promise((resolve, reject) => {
    let ws;
    const timer = setTimeout(() => {
      try { ws?.close(); } catch { /* 已关闭 */ }
      reject(new Stop('核对创世哈希超时'));
    }, timeoutMs);
    try { ws = new WebSocketImpl(url); }
    catch (e) {
      clearTimeout(timer);
      reject(new Stop('无法连接 RPC'));
      return;
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chain_getBlockHash', params: [0] }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch { /* 忽略 */ }
      if (typeof msg.result !== 'string') reject(new Stop('RPC 没有返回创世哈希'));
      else resolve(msg.result);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Stop('核对创世哈希失败'));
    };
  });
}

export async function verifyGenesis({ expected, url, fetchHash = rpcGenesis }) {
  const want = normalizeGenesis(expected);
  if (!want) throw new Stop('配置里的 genesisHash 不是 0x 加 64 位十六进制');
  const gotRaw = await fetchHash(url);
  const got = normalizeGenesis(gotRaw);
  if (!got) throw new Stop('链上返回的创世哈希无法解析，拒绝签名');
  if (got !== want) throw new Stop('创世哈希与配置不一致，拒绝签名');
  return got;
}
