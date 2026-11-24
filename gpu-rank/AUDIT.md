# 审核说明

只读选型 CLI，目录是 `gpu-rank/`。从 `main` 的 `f68f647` 新开分支，没有合并 PR #3，没有 force-push，没有改 `server.js`、`src/`、`start.sh`、`一键启动.bat` 或根上的测试。

PR #3 head `f4260f4` 只作反例，不导入、不当成可运行的租机实现。它的 `hourlyUsd` 把 `price.on_demand['USD-Blockchain'] / 24` 当成美元小时价，筛选币种却可以是 CLORE；H100 等效是 `hourly / (vram / 80)`。backend 仍是未决项。本工具不做这两件事。

## 测试

```bash
cd gpu-rank && node --test
```

2026-11-24 本地结果：21 项，21 通过，0 失败。覆盖可比组升序、跨 H100 形态不混排、CLORE 与 USD-Blockchain 拆开、每卡价不乘卡数、未知费用不为 0、0/负数/NaN/Infinity 吞吐拒绝、过期、重复 id、显存/后端/网络未知待核、理论榜默认关闭、HTTP 只允许固定 GET、以及 CLI 写出 JSON/CSV/文本。

示例夹具：

```bash
node gpu-rank/cli.js rank --input gpu-rank/fixtures/EXAMPLE.comparable.json --out /tmp/gpu-rank-example
node gpu-rank/cli.js rank --input gpu-rank/fixtures/EXAMPLE.edges.json --out /tmp/gpu-rank-edges --include-theoretical
```

`EXAMPLE.comparable.json` 的 SXM 80GB HBM3 组顺序是 `ex-clore`（1 USD/等效 H100 小时）、`ex-a`（3.125）、`ex-b`（4）。`ex-b` 的整机小时价更低，但等效价更高。PCIe 80GB HBM2e 是另一组，只有 `ex-pcie`。标签含 `EXAMPLE`，不是市场排名。报告里的 `optimalMachineSelected` 固定为 false。

## 成本口径

等效 H100 = 候选整机实测吞吐 / 同一 workload 下、写明形态、显存容量和显存代际的 H100 整机基准吞吐。

USD/等效 H100 小时 = 整机全包 USD/h / 等效 H100。组内升序。没有 GPU→H100 系数，也不按卡数放大吞吐或价格。

全包价要求：整机单位、报价币种等于支付币种、四项费用都已知且有证据、`feesComplete` 有证据、周期是带证据的 hour 或 day。只有支付币种正好是 `USD` 时汇率为 1。`USD-Blockchain` 不是 USD。`day` 除以 24 只在没有文档冲突、并且输入写了 `periodEvidence` 时发生，表示日历日，不是性能权重。月价没有显式小时数就不折算。

冲突或未知费用、未知汇率、未知计费单位、未知硬门槛：不排名，不写成 0，不写成通过。

显存、后端、网络、磁盘先筛。已知不合格则排除；未知则待核。`available` 不是 true 则待核，false 才排除。

迁移下载、重叠租金、排空、稳定性、租约/冷却只作为 known/unknown 列出来，不折成收益或空投利润。

## 真实数据

采集时间 `2026-11-24T13:38:32.995Z`。只发了允许列表里的 GET，没有 credential 头。

| 目标 | HTTP | 字节 | sha256 |
| --- | --- | --- | --- |
| `https://api.clore.ai/v1/marketplace` | 200 | 3922137 | `d088225dea8be2f196e786f7aca452ef9bb8b9b697277c8005c425bd9b86de27` |
| `https://docs.clore.ai/for-hosts/api` | 200 | 2338621 | `fca05e7135ad15411a9bc8fc86940af92c8b853879e29afe89faacc72f39292a` |
| `https://docs.clore.ai/dev/reference/api-reference` | 200 | 652346 | `3ccedaffac67ce99c9834d60bdff04681887d49b6f2b0f23960e751f5b846076` |
| `https://docs.clore.ai/dev/reference/clore-client` | 200 | 853118 | `a55f55c6995ec328bd7e3a6cbccc6111090bc0b38c242276c4df0856e0680e3a` |
| `https://docs.vast.ai/api-reference/hello-world` | 200 | 244548 | `5ede5d0e43fa74f5f84f2c592c4be16a1680c859eaa3d1765b3cc26c9e321d44` |

主机文档写 `price.on_demand` 是每天的价格，`USD-Blockchain_on_demand` 是每天的 USD。客户端参考写 `price.usd.on_demand_clore` 是 USD/hr。同一份响应里这两个字段的比值中位数约 1.0002，2085 对里 1468 对落在 1±0.02，没有成簇的 24 或 1/24。因此既不除以 24，也不把客户端字段当成小时全包价。

这次响应：`code=0`，2842 台服务器，按币种拆成 7144 条（bitcoin 2220，CLORE-Blockchain 2183，USD-Blockchain 2741）。`rented=true` 1340 台，`false` 1502 台。`my_servers` 为空。币种之间金额都不相同。归一化后 `feesComplete` 为 true 的是 0，周期被填上的是 0，`available=true` 的是 0，价格单位全部未知。用空汇率表再跑排名：ranked 0，groups 0，7144 条全部拒绝。拒绝原因同时包括缺过期时间、计费单位冲突、费用未知、缺汇率、缺同条件基准、显存单位未知、后端未知、网络未知、磁盘未知。

Vast 报价没有拉取。官方 hello-world 的搜索示例是带 bearer 的 POST `/api/v0/bundles/`。导入器只保留原始 `dph_total`，带宽金额保持 null。

原始响应体不进 git（文档 HTML 里有公开 curl 示例，本工具没有使用）。哈希和计数在 `snapshots/public/manifest.json` 与 `snapshots/public/real-snapshot-check.json`。响应体放在可回传 artifacts。

## 未完成

没有同条件 H100 实测，所以没有候选进入排名，也没有最优机器。Clore 的 `renter_fees` 和 `creation_fees` 在另一条需要 auth 头的 GET 上，没有取。没有拉公开汇率。没有跑基准。Vast 市场报价没有取。这些都不是“暂时用理论值先排一名”。

## 给审核看的点

- 确认 diff 只在 `gpu-rank/`，并且没有 order、create、delete、支付、赞助或 worker 调用。
- 确认 `optimalMachineSelected` 在代码里被写成 false，而不是算完再改口。
- Clore 的 `price.usd` 被忽略。CLORE 付款不会读取旁边的 USD-Blockchain。冲突时不除以 24。
- `partial_gpu_rental === false` 也不推断成整机价。部分租用文档写了按 `gpu_count` 缩放，这里不缩放。
- 未知费用是 `known: false` 且金额 null，不是 0。显式 0 仍要证据。
- 缺 `expiresAt` 会走 `invalid_timestamp` 拒绝。真实 7144 条因此计在 rejected，不在 pending；`allReasons` 里仍有缺基准和费用未知。如果希望缺过期时间显示为待核而不是拒绝，这是当前严格度的选择。
- 示例夹具里的 0.25 CLORE/USD 只存在于 EXAMPLE 文件。真实快照核对时汇率表是空的。
- 允许列表是精确 URL。重定向不跟随。调用方不能传入 URL，也不能传 `--order`、`--method`、`--key`。
- 多卡必须整机实测条数等于报价卡数，否则 `gpu_count_measurement_mismatch`，不乘。
- 理论榜要引用，并且要 `--include-theoretical`，不和实测组排序在一起。
