# gpu-rank

只读 GPU 租机选型。比较同一模型、revision、精度、输入/输出长度、batch、并发、指标和延迟约束下的整机实测吞吐，算出每等效 H100 小时的全包美元价格。

这个目录不 import 仓库里的租机、部署或赞助代码，也不改那些脚本。它不下单、不部署、不支付、不注册、不读 API key 或钱包。

PR #3（`f4260f4`，Draft）只作为反例：它把 `USD-Blockchain / 24` 当成限价，又用显存/80 充当 H100 系数，而且 backend 没有实现。那些口径这里不沿用，也不把那份代码当成可以上线的实现。

## 公式

同一可比组内：

```
等效 H100 = 候选整机实测吞吐 / 指定 H100 型号的同条件整机基准吞吐
USD / 等效 H100 小时 = 整机全包 USD/h / 等效 H100
```

H100 必须写明形态（PCIe、SXM、NVL 等）、显存容量和显存代际。组内按 `USD / 等效 H100 小时` 升序。不同基准各自成组，不混排。

没有内置 GPU→H100 系数。多卡只用整机实测，不把单卡吞吐或单卡价格乘卡数。缺同条件实测就列入缺口，不用理论值顶上。理论代理只有在输入里带了引用 URL 和引文，并且命令行加了 `--include-theoretical` 时，才出现在单独标记的理论榜。

`rank` 的报告始终是 `optimalMachineSelected=false`。组内第 1 名只是这一组已具备完整口径的报价里更低的一个，不是市场最优。

## 全包小时美元

全包价只在下面都成立时计算：

- `priceUnit` 是 `whole_machine`。`per_gpu` 不乘卡数。
- `quoteCurrency` 与 `paymentCurrency` 相同。CLORE 付款不会改用旁边的 `USD-Blockchain` 数字。
- `USD-Blockchain`、USDT、USDC、CLORE 都不是 USD。只有支付币种正好是 `USD` 时按 1 计；其他币种要有来源 URL、采集时间和未过期汇率。多条同时有效的汇率不挑选。
- 周期是带证据的 `hour`（÷1）或 `day`（÷24）。`day → 24` 只表示日历日，不是性能系数。月价没有单独的小时数证据就不折算。
- `billingUnitConflict` 或非空 `documentationConflicts` 直接待核，不除以 24，也不当成小时价。
- `compute`、`storage`、`bandwidth`、`platformFee` 每一项都要 `known: true`、金额、支付币种、同一周期、整机单位和证据。显式 0 也要证据。未知不是 0。
- `feesComplete: true` 和证据都要有，表示这四项就是全部费用。

## 硬门槛

显存、后端、网络、磁盘先筛。要求本身必须写成具体门槛，或者写成带证据的 `disabled`。

- 已知且不合格：排除。
- 未知、单位不明、或标了通过但没有证据：待核，不当成通过。
- `available` 不是 `true` 就待核；`false` 才排除。

迁移下载、重叠租金、排空、稳定性、租约/冷却单独列出。状态可以是 `known` 或 `unknown`。它们不进入价格，也不折成收益、空投或利润。

## 命令

在仓库根目录：

```bash
node gpu-rank/cli.js rank --input gpu-rank/fixtures/EXAMPLE.comparable.json --out /tmp/gpu-rank-example
node gpu-rank/cli.js rank --input gpu-rank/fixtures/EXAMPLE.edges.json --out /tmp/gpu-rank-edges --include-theoretical
node gpu-rank/cli.js validate --input gpu-rank/fixtures/EXAMPLE.comparable.json
node gpu-rank/cli.js fetch-public --out /tmp/gpu-rank-public --ttl-seconds 3600
node gpu-rank/cli.js candidates --body snapshot.json --collected-at 2026-11-24T13:38:32.995Z --as-of 2026-11-24T13:38:32.995Z --ttl-seconds 3600 --out /tmp/gpu-rank-candidates
node gpu-rank/cli.js enrich --candidates /tmp/gpu-rank-candidates/candidates.json --evidence evidence.json --out /tmp/enriched.json
cd gpu-rank && node --test
```

`rank` 写出 `report.json`、`report.csv`、`report.txt`。退出码 0 表示报告已写出，包括“没有人进入排名”。结构不合法时退出码 2。

`EXAMPLE.comparable.json` 和 `EXAMPLE.edges.json` 的标签含有 `EXAMPLE`。它们是算术和校验夹具，不是市场排名。

`fetch-public` 只对写死的 https URL 发 GET，不接受调用方传入的 URL，不跟随重定向，不发送 credential 头，不读环境变量。2026-11-24T13:38:32.995Z 的一次采集里，Clore marketplace 在没有 credential 的情况下返回 HTTP 200，但 7144 条币种报价全部没有进入排名。摘要在 `snapshots/public/manifest.json`。允许的地址：

- `GET https://api.clore.ai/v1/marketplace`（文档要求 auth 头；这里不发送）
- `GET https://docs.clore.ai/for-hosts/api`
- `GET https://docs.clore.ai/dev/reference/api-reference`
- `GET https://docs.clore.ai/dev/reference/clore-client`
- `GET https://docs.vast.ai/api-reference/hello-world`

Vast 官方 hello-world 的搜索是带 bearer 的 `POST /api/v0/bundles/`。本工具不调用它。已保存的 Vast JSON 可以用 `vastSnapshotOffers` 导入；`dph_total` 只作为原始数字，带宽和手续费保持未知。

## 字段

见 `SCHEMA.md`。校验实现在 `src/schema.js`、`src/money.js` 和 `src/rank.js`。
