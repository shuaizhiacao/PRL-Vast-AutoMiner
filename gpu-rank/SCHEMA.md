# 输入 schema `gpu-rank.input.v1`

时间都是带 `Z` 的 UTC ISO-8601。URL 必须是 https，且不能带用户名或口令。数字必须是 JSON number；字符串不会被转成数字。

## 文档

| 字段 | 要求 |
| --- | --- |
| `schemaVersion` | `gpu-rank.input.v1` |
| `dataset.id` | 非空字符串 |
| `dataset.kind` | `example` 或 `market-snapshot` |
| `dataset.label` | 非空。`example` 必须包含 `EXAMPLE`。市场快照不能把自己标成最优 |
| `dataset.collectedAt` | 采集时间 |
| `dataset.sourceUrls` | https 列表 |
| `asOf` | 判断过期和汇率的时间 |
| `maxAgeSeconds` | 可选。报价采集早于 `asOf - maxAgeSeconds` 则拒绝 |
| `workload` | 本次唯一的可比口径，见下 |
| `baselines` | H100 整机基准。不合格的基准被丢弃并写入缺口 |
| `requirements` | 四道硬门槛，每道都要显式 mode |
| `fx` | 到 USD 的汇率。可以为空数组 |
| `offers` | 报价。单条不合法不会毁掉整份文件 |

## workload

`modelId`、`revision`、`precision`、`metric` 为非空字符串，比较时区分大小写，不把 `fp16` 和 `FP16` 当成同一个基准。

`inputTokens` 是 ≥0 的整数。`outputTokens`、`batchSize`、`concurrency` 是 ≥1 的整数。`maxLatencyMs` 是正的有限数。

`protocol` 必填：`id`、`latencyStatistic`（`avg`、`p50`、`p95`、`p99`、`ttft_p99`、`e2e_p99` 之一）、`engineIdentity`（`must_match` 或 `unconstrained`）。`must_match` 时 `engine` 也必填，基准和候选必须使用同一个引擎。`unconstrained` 允许不同引擎留在同一组，但报告仍写出引擎，不把差异当成已经核实。

`latencyMs` 必须是有限数并且 ≥ 0。0 表示记录到的 0 毫秒，不是未知。缺失、null、字符串、NaN、Infinity 和负数都不能进入榜单。比较时先确认 `finite()` 不是 null，再比上下界。

## baseline

`kind` 必须是 `measured`。`gpu.model` 必须是 `H100`。`gpu.formFactor` 只能是 `PCIe`、`SXM`、`NVL`。`gpu.memoryGeneration` 只能是 `HBM2e`、`HBM3`。`gpu.vramGb` 只能是 80 或 94。这些是参照身份，不是性能系数。`gpuCount` 是 ≥1 的整数。1 卡的单位是 `1xH100`，并写出 `eqH100`。多卡整机单位是 `NxH100-node`，`eqH100` 留空，不除以卡数。`throughputScope` 必须是 `whole_machine`。`workload`、`protocol` 与文档一致。`latencyMs` 是有限数、≥ 0 且不超过约束。`machineFingerprint`、`sourceUrl`、`collectedAt`、`evidence` 都要有。baseline id 在文件内唯一，重复则整份文件失败。

## requirements

每一项都是对象。

- `vram.mode`: `min_gb_per_gpu`（`minGb` > 0）或 `disabled`（要 `evidence`）
- `backend.mode`: `allowlist`（非空 `names`）或 `disabled`
- `network.mode`: `min_mbps`（`downMbps`、`upMbps` 都 > 0）或 `disabled`
- `disk.mode`: `min_gb`（`minGb` > 0）或 `disabled`

## fx

`base` 是非 USD 币种，`quote` 必须是 `USD`，`rate` > 0，`sourceUrl`、`asOf`、`expiresAt` 齐全。结构不合法会让整份文件失败，避免静默丢掉一条坏汇率。

## offer

| 字段 | 要求 |
| --- | --- |
| `id` | 同一文件内唯一。重复 id 全部拒绝 |
| `marketplace` | 非空 |
| `sourceUrl` | https |
| `collectedAt` / `expiresAt` / `validity` | `expiresAt` 是供应商有效期。没有它时，可以给 `validity.source=local_policy` 和正的 `ttlSeconds`，并标明这不是供应商可租承诺。两者都没有则待核，不当成永不过期。供应商时间已过是 `vendor_expired`；本地 TTL 已过是 `local_observation_stale`。`maxAgeSeconds` 仍单独约束采集时间。`vendorGuaranteesAvailability: true` 会被待核，输出里这个字段固定为 false |
| `available` | `true` 还要 `availabilityEvidence`。`false` 排除。其他待核 |
| `gpu.count` | 整数 ≥1，否则待核或拒绝。不从型号字符串里猜卡数 |
| `gpu.model` | 非空才算已知 |
| `gpu.vramGbEach` | 每卡显存。启用每卡门槛时 `vramScope` 必须正好是 `per_gpu`。缺失、空串、`total`、`unknown` 都待核 |
| `diskGb` / `diskEvidence` | 磁盘门槛启用时必填 |
| `network.downMbps` / `upMbps` / `evidence` | 网络门槛启用时必填 |
| `backend.name` / `compatible` / `evidence` | `compatible: true` 且名字在允许列表里，并有证据 |
| `quote` | 见下 |
| `benchmarks` | 见下。空数组是缺基准，不是理论值 |
| `ops` | 五个键都要在：`migrationDownload`、`overlapRent`、`drain`、`stability`、`leaseCooldown` |

报价上多出来的字段会被记入 `ignoredOfferKeys`，不参与计算。因此 `decoyUsdBlockchainPerDay` 这类字段不能改变全包价。

## quote

`priceUnit`：`whole_machine` 或会被待核的 `per_gpu`。

`amount` 是有限正数，只作原始标价。全包价用 `components`，不用这个数字乘卡数或换币。

`quoteCurrency` 与 `paymentCurrency` 必须相同。

`period`：`hour`、`day`，或 `explicit` 加正的 `periodHours`。都要非空 `periodEvidence`。

`billingUnitConflict: true` 或非空 `documentationConflicts`：计费单位冲突，不折算。

`feesComplete` 与 `feesCompleteEvidence`：声明费用已经列全。

`components.compute`、`storage`、`bandwidth`、`platformFee`：

- `known: true`
- `amount` ≥ 0，compute 必须 > 0
- `currency` 等于支付币种
- `period`、`unit: whole_machine`
- `evidence` 非空

## benchmark

`kind` 是 `measured` 或 `theoretical`。

与文档 workload 不一致的条目不进入这一次比较。一致但吞吐不是有限正数：拒绝整条报价。

还要：`latencyMs` 在约束内，`throughputScope=whole_machine`，`gpuCountAtMeasurement` 等于报价 GPU 数量，https `sourceUrl`，`collectedAt` 不晚于 `asOf`，`baselineId` 指向合格基准。

同一口径多条实测：待核，不挑选。

`theoretical` 还要 `citationUrl` 和 `citationQuote`。默认不进实测榜。

## 报告 `gpu-rank.report.v1`

`groups` 是实测可比组。`theoreticalBoards` 只在请求理论榜时出现。`pending`、`excluded`、`rejected` 带原因码。`optimalMachineSelected` 和 `rankedIsMarketOptimum` 固定为 false。

原因码的中文在 `src/reasons.js`。
