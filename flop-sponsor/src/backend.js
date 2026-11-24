// Clore 市场上的标准交付物是容器。官方矿工是 worker + miner-vllm-toploc 两个 Compose 服务，
// 还要公网 HTTPS 80/443。容器里再套 Docker 不可靠，所以这里不生成 docker compose 命令。
// 密钥留在常驻 worker 主机。GPU 机器只跑 backend，端口不公开，靠反向隧道接回 worker。
// 镜像 digest、MODEL_HASH、隧道程序都没有在本脚本里写死。

export function unresolvedBackend() {
  return {
    id: 'unresolved',
    plan() {
      return [
        { id: 'worker-stays', text: 'worker、矿工密钥和 Caddy/443 留在常驻主机，不进 Clore 容器。' },
        { id: 'backend-only', text: 'Clore 只启动 backend 镜像。具体镜像必须是 vX.Y.Z@sha256 digest，本接口不填。' },
        { id: 'tunnel', text: 'backend 端口不对公网开放，用运营方自己的反向隧道接到 worker。隧道软件未选定。' },
        { id: 'no-register', text: '不执行 miner register，也不在 GPU 容器里跑 sponsor.sh。' },
      ];
    },
    async start() {
      return {
        ok: false,
        ready: false,
        unresolved: [
          'backend 镜像 digest 未配置',
          'MODEL_HASH / DECODE_POLICY 未由本脚本核验',
          '反向隧道未实现',
        ],
      };
    },
  };
}

export function backendFrom(cfg) {
  if (cfg.backend && typeof cfg.backend.start === 'function' && typeof cfg.backend.plan === 'function') {
    return cfg.backend;
  }
  return unresolvedBackend();
}
