// vast.ai REST API（按官方文档 docs.vast.ai 与官方 vast-cli 源码实现）
//   搜索:   POST   /api/v0/bundles/
//   租用:   PUT    /api/v0/asks/{offer_id}/
//   实例:   GET    /api/v1/instances/（分页，每页最多 25 台；旧的 /api/v0/instances/ 列表接口已被 vast 停用，返回 410）
//   销毁:   DELETE /api/v0/instances/{id}/
//   余额:   GET    /api/v0/users/current   (字段 credit)
import { request } from './http.js';

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
  // vast 按「返回的条数」计每日搜索额度（UTC 0 点重置），所以只取每美元算力最高的前 N 条
  // names：只搜这些型号（vast 的 gpu_name 原样字符串），省掉不适合挖矿的卡占用的搜索条数
  async searchOffers(f, meta, names) {
    const q = {
      verified: { eq: true },
      external: { eq: false },
      rentable: { eq: true },
      rented: { eq: false },
      reliability: { gte: f.minReliability },
      num_gpus: { gte: 1, lte: f.maxGpusPerMachine },
      dph_total: { lte: Math.max(0.01, f.maxHourlySpend) }, // 单机时租不可能超过总预算
      cuda_max_good: { gte: f.minCuda },
      inet_down: { gte: f.minInetDown },
      order: [['flops_per_dphtotal', 'desc']],
      type: 'on-demand',
      limit: Math.max(20, Math.min(1000, f.scanRows || 100)),
      allocated_storage: f.disk,
      ...(names?.length ? { gpu_name: { in: names } } : {}),
    };
    const r = await request(`${BASE}/bundles/`, { method: 'POST', headers: this.h(), body: q, timeoutMs: 45000, meta });
    return r?.offers || [];
  }

  // 租用一个 offer 并部署。cancel_unavail=true：机器已被别人租走时直接失败，不会留下排队中的实例
  // mode 'args'：跳过 vast 的 SSH 初始化（apt 装 ssh/tmux 等，慢机器要好几分钟），容器直接用 bash 运行开机脚本
  // mode 'ssh'：原来的方式，能 SSH / Jupyter 登录，脚本作为 onstart 运行
  async rent(offerId, { image, disk, label, onstart, mode = 'ssh' }) {
    const body = {
      client_id: 'me',
      image,
      env: {},
      price: null,
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
