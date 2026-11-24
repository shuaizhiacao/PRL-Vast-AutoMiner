# FLOP 赞助编排（独立脚本）

这个目录可以单独拷走运行，不引用、不修改本仓库的 Vast / Pearl 代码。默认 **DRY**：只读 `/limits`、做门禁判断、打印将要签名的消息原文和将要提交的正文形状。不租机、不向水龙头提交赞助、不挖矿。

```bash
cd flop-sponsor
npm install
node index.js --once
node index.js keygen --out data/signer
node index.js sign-dry --signer data/signer
```

`data/`、`config.json`、密钥和 SSH 私钥已在本目录 `.gitignore` 里。不要把它们提交到 git。

## 安全默认

真要写远端，必须同时满足：

- 配置 `dryRun=false`
- 配置 `autoApply=true` 且 `autoRent=true`
- 环境变量 `FLOP_CONFIRM_LIVE=1`

少任意一项都会拒绝，而不是静默改成试跑。Clore 密钥只从环境变量 `CLORE_API_KEY` 读取。矿工私钥只从 `signerFile` 读取，并且文件权限必须是 `0600`。日志不写私钥、签名、SSH 材料。

公开赞助路由按官方说明是每个地址每分钟 6 次。客户端自己限速，并且全局单飞，避免官方返回 `account_busy`。一个账户只做一次赞助，不新建账户绕过限额，也不调用 `miner register`。

## 官方依据

以下以 2026-11-24 拉到的公开文档和发行包为准。

- 矿工 FAQ：<https://docs.flop.network/docs/miner-faq>
- 在 GPU 主机上跑矿工：<https://docs.flop.network/docs/run-miner>
- 发行包说明：<https://flop.network/releases/cli/miner-pack-devnet-ts-20261110/README.md>
- 发行包 `flop-miner-pack-devnet-ts-20261110.tar.gz` 的 SHA256：`72546fc4f020ec665d7b8c54aa0cddd336e95d2c93b650ca77e82e35607e8f0d`
- 实时限额：<https://faucet.flop.network/limits>
- Clore API：<https://docs.clore.ai/for-hosts/api>

发行包里的 `sponsor-request.mjs`（由 `sponsor.sh` 在官方 CLI 镜像里执行）写明了签名字节，本脚本按它实现，没有把官方文件复制进来：

- 密钥：`Keyring({ type: 'sr25519', ss58Format: 42 }).addFromUri(单行短语)`
- 消息：`flop-sponsor/v1|miner|<genesis 哈希>|<地址>|<issuedAt>`
- `issuedAt` 是 `String(Date.now())`，单位毫秒
- 签名：`0x` + `pair.sign(utf8 字节)` 的十六进制
- 提交前用 `@polkadot/util-crypto` 的 `signatureVerify` 自检
- `POST {address, issuedAt, signature}` 到 `https://faucet.flop.network/sponsor/miner`
- 赞助成功即注册矿工。不要再跑 `miner register`

创世哈希默认是 devnet 的 `0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631`。启动时用 `chain_getBlockHash(0)` 和配置对照，不一致就拒绝签名。

`keygen` 用的是同一套 `@polkadot/util-crypto` 的 `mnemonicGenerate`，再交给上面的 `addFromUri`。官方生成命令是发行包里的 `zkv-relay key generate --scheme sr25519 --output-type json`，本环境没有跑这个二进制做逐字节对照，所以「和 zkv-relay 输出同一条助记词」未确认。可以确认的是：生成出来的单行短语能被官方赞助脚本使用的同一个 Keyring 读入、签出并通过自检。`miner.env.example` 的注释把 signer 写成 `0x` 种子，而 `sponsor-request.mjs` 实际是 `addFromUri`。worker 二进制要哪一种，没有在这里执行核对，列在未决项。

## 席位

默认每 30–60 秒读一次 `GET https://faucet.flop.network/limits`（带抖动）。低于 30 秒的配置会被夹回去。限额全部读当次 JSON，脚本里不写 1000、200 这种数字。

实况字段是：

- `sponsor.miner.status`
- `capacity.used` / `capacity.max`
- `dailyNewSponsorships.used` / `dailyNewSponsorships.limit`
- `dailyStakeBudget.usedFlop` / `dailyStakeBudget.limitFlop`
- `automatic.open` / `uncalibrated` / `max` / `graceHours`

对不上这几种形状就停止，不猜测。`network` 不符、`status !== "open"`、容量或质押预算用尽、自动通道关闭，都是等待。`dailyNewSponsorships` 用尽则等到下一个 UTC 午夜再读。通过后写本地席位意图，TTL 10 分钟。

`sponsorMode=review` 时，自动通道关闭不再单独挡住。审查提交地址必须写在 `review.submitUrl`。官方测试网申请入口还没公布，空着就停止并提示，不会编一个 URL。批准前不租机；批准信号是本地文件 `review.approvedFile`（由人写上内容），不是猜出来的查询接口。

## 状态机

`SEAT_CHECK → SPONSOR_SIGN → SPONSOR_SUBMIT → SPONSORED → RENT_INTENT → RENT_UNKNOWN → RENTED → BOOTSTRAP → CALIBRATE → READY`

状态在 `data/state.json`。硬条件：

- 没有未过期的 `SEAT_OK`，不下单
- 创世哈希没核对过，不签名
- `create_order` 在记账成 `RENT_UNKNOWN` 之后才发出。超时后先 `my_orders` 对账，对账完成前不重下
- 成功响应若只有 `{code:0}`、没有订单号，用 `si = server id` 且 `ct` 落在下单意图时间 ±120 秒来认订单。多笔命中就停止
- HTTP 200 但 `code != 0`（例如 6）是拒绝，不是成功
- `code === 0` 但对账仍为空时，不再自动下第二单
- 容器起来后先跑 `nvidia-smi` 和磁盘检查。不达标记失败。只有 `autoCancelOnFail=true` 才退租，而且 `cancel_order` 返回 0 之后还要看到订单离开活动列表
- 下单间隔至少 5 秒，禁止并发。只用 on-demand，不用 spot。`rental_hours` 和 `auto_renew` 可配，默认不自动续租

赞助响应：200/201 成功；409 已赞助，当作成功继续；403 停止；429 按 `retryAfterSeconds` 等，不换地址；没有 `retryAfterSeconds` 的 429 停止；503 稍后重试；`account_busy` 在锁内用同一正文再试一次。

## Clore 上只跑 backend

Clore 标准市场交付的是容器。官方矿工是 worker 加 `miner-vllm-toploc` 的 Compose，还要公网 80/443。容器里再套 Docker 不可靠。因此本脚本的部署是一个可替换的 backend 接口：密钥和 Caddy/443 留在常驻 worker 主机，Clore 只准备跑 backend，backend 端口不公开，用运营方自己的反向隧道接回 worker。

默认实现 `unresolved` 只打印这个计划，不启动容器，也不猜镜像 digest、`MODEL_HASH`、解码策略或隧道程序。发行包 `releases.json`（2026-11-10 这个包）里有 `miner-worker` 和 `miner-vllm-toploc` 的 pin，但那些值会过期，所以没有写进可执行默认值。

矿工私钥不要拷进 Clore 容器。租用磁盘对供应商是可见的。本脚本不会 scp 私钥。

## 子命令

- `keygen --out <file>`：生成单行短语，权限 `0600`，只打印地址
- `sign-dry --signer <file>`：核对创世哈希，打印地址、待签消息原文、本地验签是否通过。不打印签名，不 POST
- `run --once`：跑一轮。不加 `--once` 时按门禁等待

## 测试

```bash
cd flop-sponsor && npm test
```

测试全部走本地 mock，不调用 Clore 写接口，也不向水龙头提交赞助。

## 未决

- 没有运行 `zkv-relay key generate`，因此 keygen 与该二进制的逐字节一致性未确认
- worker 进程要的 signer 究竟是助记词还是 `0x` 种子，未对 worker 二进制核对
- Clore 容器里的 backend 启动参数、镜像 digest、模型哈希、反向隧道未实现
- 审查模式的官方 URL 未公布
- 校准完成的判定信号未接；默认停在 `CALIBRATE`
- 闲时 Pearl 只有 `src/pearl.js` 里的 TODO，不切换、不读钱包
