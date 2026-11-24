// 闲时 Pearl。本版只留接口。
// TODO: 矿工进入 READY 且当前没有 FLOP 会话时，才讨论是否切到 Pearl。
// 不要在这里读钱包、不要租机器、不要启动矿工。
export function maybeIdlePearl({ minerReady = false, flopSessionActive = null } = {}) {
  return {
    action: 'noop',
    minerReady: minerReady === true,
    flopSessionActive,
    todo: '矿工就绪且没有 FLOP 会话时再考虑 Pearl。本版不实现切换。',
  };
}
