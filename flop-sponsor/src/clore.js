import { request } from './http.js';
import { Stop } from './errors.js';
import { CREATE_COOLDOWN_MS, RECONCILE_WINDOW_SEC } from './time.js';
import { createSingleFlight } from './lock.js';

const createFlight = createSingleFlight();

export function classifyCreate(res) {
  if (!res || typeof res.data?.code !== 'number') {
    return { kind: 'unknown' };
  }
  if (res.data.code === 0) return { kind: 'accepted' };
  return { kind: 'rejected', code: res.data.code, error: res.data.error || `code ${res.data.code}` };
}

export function matchNewOrder(orders, { serverId, intentAtSec, windowSec = RECONCILE_WINDOW_SEC }) {
  const hits = [];
  for (const order of orders || []) {
    if (!order || typeof order !== 'object') continue;
    if (order.expired === true) continue;
    if (Number(order.si) !== Number(serverId)) continue;
    const ct = Number(order.ct);
    if (!Number.isFinite(ct)) continue;
    if (Math.abs(ct - intentAtSec) > windowSec) continue;
    hits.push(order);
  }
  return hits;
}

// 下单前接管：已经记过的订单号，或环境里带 flop- 前缀的活跃订单。
export function adoptableOrders(orders, { orderId, tag } = {}) {
  const hits = [];
  for (const order of orders || []) {
    if (!order || order.expired === true) continue;
    const id = orderIdOf(order);
    if (orderId != null && id === orderId) {
      hits.push(order);
      continue;
    }
    const marked = String(order.env?.FLOP_TAG || order.tag || '');
    if (tag && marked === tag) hits.push(order);
    else if (marked.startsWith('flop-')) hits.push(order);
  }
  return hits;
}

export function orderIdOf(order) {
  if (Number.isInteger(order?.id)) return order.id;
  if (Number.isInteger(order?.order_id)) return order.order_id;
  return null;
}

export function parseSshEndpoint(order) {
  const host = Array.isArray(order?.pub_cluster) ? order.pub_cluster.find(s => typeof s === 'string' && s) : null;
  let port = null;
  for (const item of order?.tcp_ports || []) {
    const m = String(item).match(/^22:(\d+)$/);
    if (m) port = Number(m[1]);
  }
  if (!host || !port) return null;
  // Clore 把容器 22 映到高位端口。80/443 和小于等于 1024 的端口不当作 SSH。
  if (port <= 1024 || port === 80 || port === 443) return null;
  return { host, port, user: 'root' };
}

export function planOrder({ serverId, image, currency, tag, rentalHours, autoRenew, autoRenewMaxPrice, publicKey }) {
  if (!image) throw new Stop('未配置 Clore 镜像，拒绝猜测');
  if (!tag || !String(tag).startsWith('flop-')) throw new Stop('订单 tag 必须以 flop- 开头');
  const body = {
    currency,
    image,
    renting_server: serverId,
    type: 'on-demand',
    ports: { '22': 'tcp' },
    autossh_entrypoint: true,
    auto_renew: autoRenew === true,
    env: {
      FLOP_TAG: tag,
      NVIDIA_VISIBLE_DEVICES: 'all',
    },
  };
  if (rentalHours != null) body.rental_hours = rentalHours;
  if (autoRenew === true) body.auto_renew_max_price = autoRenewMaxPrice;
  body.ssh_key = publicKey || '<live 时生成的公钥，DRY 不生成>';
  return body;
}

export function redactOrder(body) {
  const copy = JSON.parse(JSON.stringify(body));
  if (copy.ssh_key) copy.ssh_key = '<redacted>';
  if (copy.ssh_password) copy.ssh_password = '<redacted>';
  return copy;
}

export function createClore({
  baseUrl,
  apiKey,
  fetchImpl,
  now = Date.now,
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
  cooldownMs = CREATE_COOLDOWN_MS,
  lastCreateAt = 0,
}) {
  let last = lastCreateAt || 0;
  const headers = { auth: apiKey || '' };

  async function get(pathname) {
    return request(`${baseUrl}${pathname}`, { method: 'GET', headers, fetchImpl });
  }

  return {
    marketplace() { return get('/marketplace'); },
    myOrders() { return get('/my_orders'); },
    async createOrder(body) {
      return createFlight(async () => {
        const wait = cooldownMs - (now() - last);
        if (last && wait > 0) await sleep(wait);
        last = now();
        return request(`${baseUrl}/create_order`, { method: 'POST', headers, body, fetchImpl, timeoutMs: 60_000 });
      });
    },
    cancelOrder(id) {
      return request(`${baseUrl}/cancel_order`, { method: 'POST', headers, body: { id }, fetchImpl });
    },
    lastCreateAt() { return last; },
  };
}

export async function confirmCancel(clore, id) {
  const res = await clore.cancelOrder(id);
  const classified = classifyCreate(res);
  if (classified.kind !== 'accepted') {
    return { done: false, reason: 'cancel-not-accepted', detail: classified };
  }
  const listed = await clore.myOrders();
  const orders = listed.data?.orders || [];
  const still = orders.some(o => orderIdOf(o) === id && o.expired !== true);
  return { done: !still, reason: still ? 'still-active' : 'gone', code: res.data?.code ?? null };
}
