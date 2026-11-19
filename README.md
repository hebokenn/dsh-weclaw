# dsh-weclaw

把企业微信「大圆」客户端的模型额度接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

[English](README.en.md)

## 原理

大圆客户端在本机跑一个只接受 mTLS 客户端证书的模型网关（`https://127.0.0.1:9883`）。
DSH 的模型适配器出示不了客户端证书，握手会失败。本插件在宿主里起一个本地明文代理
（`http://127.0.0.1:9885`），由它从运行中的 `wecom-agent` 进程环境读出证书，再用 mTLS
重新发起请求；同时在模型选择页里声明一个 `weclaw` provider。

证书只驻内存、每 5 分钟刷新、不落盘；大圆重启轮换证书后不用重启 DSH。

## 要求

- macOS（证书来自 `wecom-agent` 进程环境）
- 大圆客户端正在运行并已登录
- DSH 0.x（插件以 `dsh.bundle.patch` 形式声明）

## 安装

```sh
dsh plugin --profile desktop add dsh-weclaw
```

本地开发用 checkout 直接链进去：

```sh
dsh plugin --profile desktop add link:/path/to/dsh-weclaw
```

装好后在模型选择页选「企业微信大圆 · …」。

> 如果之前手工在 profile patch 里配过指向 `127.0.0.1:9885` 的 `weclaw` provider，请先删掉
> 那一段——provider 重复声明会让宿主启动失败。

## 已适配的上游模型

| 选择项 | 上游 id | 输入 |
| --- | --- | --- |
| 大圆 · DeepSeek-V4.1-Flash | `MiniMax-M2.5-WW-128K-Test` | 文本 |
| 大圆 · HY-Vision（图文） | `HY-vision-1.5-instruct` | 文本 + 图像 |

网关按请求的 `model` 选后端，回报的 id 本身不可再请求，所以代理内置了别名映射。
要换映射，用 `WECLAW_ROUTES='{"alias":"upstream-id"}'` 整体覆盖。

## 配置

`cordis.patch.yml` 里 `weclaw-proxy` 条目的配置，全部可省略：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 代理监听地址 |
| `port` | `9885` | 代理监听端口 |
| `upstreamHost` | `127.0.0.1` | 大圆网关地址 |
| `upstreamPort` | `9883` | 大圆网关端口 |
| `stallMs` | `100000` | 上游静默多久后断开重试 |
| `autoStart` | `true` | `false` 时只探测、不拉起代理 |
| `routes` | 内置 | 模型别名映射 |

## 排查

- `curl http://127.0.0.1:9885/healthz` 应返回 `{"ok":true,...}`；没有返回说明代理没起来，
  看宿主日志里 `[dsh-weclaw]` 前缀的行。
- `curl http://127.0.0.1:9885/v1/models` 能看到代理声明的模型目录。
- 回复正文为空、只有思考过程：该端点 reasoning 占比很高，`maxTokens` 别调太小。
- 大圆退出后请求会报上游不可用；重新打开大圆即可，代理会自动刷新证书。

## 许可

MIT
