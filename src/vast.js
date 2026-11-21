// vast.ai REST API（按官方文档 docs.vast.ai 与官方 vast-cli 源码实现）
//   搜索:   POST   /api/v0/bundles/     type: "on-demand" | "bid" | "reserved"
//   租用:   PUT    /api/v0/asks/{offer_id}/
//            price 省略或 null = 按需；price 为美元/小时 = 可中断出价（低于 min_bid 会被拒绝）
//   实例:   GET    /api/v1/instances/（分页，每页最多 25 台；旧的 /api/v0/instances/ 列表接口已被 vast 停用，返回 410）
//   销毁:   DELETE /api/v0/instances/{id}/
//   余额:   GET    /api/v0/users/current   (字段 credit)
// 搜索排序用 dph_total 升序（该型号最便宜的几条），不用 flops_per_dphtotal。
// FLOPS/$ 和卡数不成比例，会把挖矿划算但 FLOPS 不高的型号挤出有限的返回条数。
import { request } from './http.js';
import { rentModeOf, vastSearchType } from './economics.js';

const ROOT = 'https://console.vast.ai';
const BASE = `${ROOT}/api/v0`;

export class Vast {
  constructor(apiKey) { this.apiKey = apiKey; }
  get ok() { return !!this.apiKey; }
  h() { return { Authorization: `Bearer ${this.apiKey}` }; }

  async user() {
    return request(`${BASE}/users/current/`, { headers: this.h() });
  }

  // 列出自己的所有实例。和官方 vast-cli 一样走 v1 分页接口：每页最多 25 台，用上一页返回的 next_token 当 after_token 翻页，
  // 不指定 select_cols，返回的字段和旧 v0 接口一样。万一 v1 接口不存在（404/405），退回旧的 v0 接口
  async instances() {
    const rows = [];
    const params = { select_filters: {}, order_by: [{ col: 'id', dir: 'asc' }], limit: 25 };
    for (let page = 0; page < 40; page++) {
      const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v))}`).join('&');
      let r;
      try { r = await request(`${ROOT}/api/v1/instances/?${qs}`, { headers: this.h() }); }
      catch (e) {
        if (page === 0 && (e.status === 404 || e.status === 405)) {
          const old = await request(`${BASE}/instances/?owner=me`, { headers: this.h() });
          return old?.instances || [];
        }
        throw e;
      }
      rows.push(...(r?.instances || []));
      const next = r?.next_token;
      if (!next) break;
      params.after_token = next;
    }
    return rows;
  }

  // 与官方 CLI search_offers 的默认过滤一致：verified / external=false / rentable / rented=false
  // vast 按「返回的条数」计每日搜索额度（UTC 0 点重置）。
  // names：只搜这些型号（vast 的 gpu_name 原样字符串）。
  // extra.limit：这一次请求的条数（按型号取最便宜的几条）。extra.id：下单前按 offer id 复核。
  // extra.order 默认 dph_total 升序。不要改回 flops_per_dphtotal。
  async searchOffers(f, meta, names, extra = {}) {
    const q = searchBody(f, names, extra);
    const r = await request(`${BASE}/bundles/`, { method: 'POST', headers: this.h(), body: q, timeoutMs: 45000, meta });
    return r?.offers || [];
  }

  // 租用一个 offer 并部署。cancel_unavail=true：机器已被别人租走时直接失败，不会留下排队中的实例
  // mode 'args'：跳过 vast 的 SSH 初始化（apt 装 ssh/tmux 等，慢机器要好几分钟），容器直接用 bash 运行开机脚本
  // mode 'ssh'：原来的方式，能 SSH / Jupyter 登录，脚本作为 onstart 运行
  // price：可中断出价（美元/小时）。按需必须传 null，不能省略成一个数字，否则 vast 会按出价单创建。
  async rent(offerId, { image, disk, label, onstart, mode = 'ssh', price = null }) {
    if (price != null && !(Number.isFinite(price) && price > 0)) throw new Error('出价无效');
    const body = {
      client_id: 'me',
      image,
      env: {},
      price,
      disk,
      label,
      cancel_unavail: true,
      ...(mode === 'args'
        ? { runtype: 'args', onstart: 'bash', args: ['-c', onstart] } // 与官方 CLI `--onstart-cmd bash --args -c '...'` 相同
        : { runtype: 'ssh_proxy', onstart }),
    };
    return request(`${BASE}/asks/${offerId}/`, { method: 'PUT', headers: this.h(), body, timeoutMs: 60000 });
  }

  // 读取机器日志（官方 CLI `vastai logs`）：PUT request_logs 拿到结果地址，再轮询下载
  async logs(id, tail = 200) {
    const r = await request(`${BASE}/instances/request_logs/${id}/`, { method: 'PUT', headers: this.h(), body: { tail: String(tail) }, timeoutMs: 30000 });
    if (!r?.result_url) return typeof r === 'string' ? r : (r?.msg || '');
    for (let i = 0; i < 20; i++) {
      await new Promise(ok => setTimeout(ok, 600));
      try {
        const res = await fetch(r.result_url);
        if (res.status === 200) return await res.text();
      } catch {}
    }
    throw new Error('日志还没准备好，稍后再试');
  }

  // 重启容器（与官方 CLI reboot instance 相同）：停止再启动，磁盘数据保留，开机脚本重新执行
  async reboot(id) {
    return request(`${BASE}/instances/reboot/${id}/`, { method: 'PUT', headers: this.h(), body: {}, timeoutMs: 30000 });
  }

  // 改实例标签（官方 CLI `label instance`）。机器上的挖矿脚本每分钟读一次标签里的 pool=xxx
  async setLabel(id, label) {
    const r = await request(`${BASE}/instances/${id}/`, { method: 'PUT', headers: this.h(), body: { label }, timeoutMs: 30000 });
    if (r && r.success === false) throw new Error(r.msg || r.error || '修改标签失败');
    return r;
  }

  async destroy(id) {
    return request(`${BASE}/instances/${id}/`, { method: 'DELETE', headers: this.h(), body: {}, timeoutMs: 30000 });
  }
}

export function searchBody(f, names, extra = {}) {
  const limit = Math.max(1, Math.min(200, extra.limit || f.scanRows || 20));
  const type = extra.type || vastSearchType(rentModeOf(f));
  const cap = Math.max(0.01, f.maxHourlySpend);
  // 可中断搜索按 min_bid（美元/小时）封顶和排序。dph_total 是按需总价，用它过滤会丢掉出价其实很便宜的机器。
  const priceFilter = type === 'bid'
    ? { min_bid: { lte: cap }, order: extra.order || [['min_bid', 'asc']] }
    : { dph_total: { lte: cap }, order: extra.order || [['dph_total', 'asc']] };
  const q = {
    verified: { eq: true },
    external: { eq: false },
    rentable: { eq: true },
    rented: { eq: false },
    reliability: { gte: f.minReliability },
    num_gpus: { gte: 1, lte: f.maxGpusPerMachine },
    ...priceFilter,
    cuda_max_good: { gte: f.minCuda },
    inet_down: { gte: f.minInetDown },
    type,
    limit,
    allocated_storage: f.disk,
    ...(names?.length ? { gpu_name: { in: names.slice(0, 64) } } : {}),
  };
  if (extra.id != null) q.id = { eq: extra.id };
  return q;
}
