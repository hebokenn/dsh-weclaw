# dsh-weclaw

把企业微信「大圆」客户端的模型额度接进 DeepSeek Harness。

## 它解决什么

大圆客户端在本机跑一个模型网关 `https://127.0.0.1:9883`，协议是 OpenAI Chat Completions，
但 TLS 握手要求出示 `wecom-agent` 的 mTLS 客户端证书。DSH 的模型适配器无法出示客户端证书，
直接配 `https://127.0.0.1:9883/v1` 会在握手阶段失败。

本插件做两件事：

1. 随宿主起停一个本地明文代理 `http://127.0.0.1:9885`，把请求重新以 mTLS 发往 9883；
2. 声明一个 `weclaw` provider，让模型选择页里出现「企业微信大圆」。

## 证书从哪来

代理不读取任何配置文件：它用 `pgrep` 找到运行中的 `wecom-agent` 进程，再用 `ps eww` 读出该进程
环境变量里的 `WECLAW_MTLS_CLIENT_CERT` / `WECLAW_MTLS_CLIENT_KEY` / `WECLAW_MTLS_CA_CERT`。
证书只驻内存，5 分钟刷新一次；大圆重启轮换证书后无需重启 DSH。

因此**大圆客户端必须处于运行状态**，否则代理没有证书，请求会报上游不可用。

## 已适配的上游模型

网关按请求里的 `model` 字段选择后端，且它回报的模型 id 本身不可再次请求。实测本租户可用：

| 选择项 | 上游 id | 输入 |
| --- | --- | --- |
| 大圆 · DeepSeek-V4.1-Flash | `MiniMax-M2.5-WW-128K-Test` | 文本 |
| 大圆 · HY-Vision（图文） | `HY-vision-1.5-instruct` | 文本 + 图像 |

代理内置别名映射，可用环境变量 `WECLAW_ROUTES='{"alias":"upstream-id"}'` 整体覆盖。

## 配置项

插件条目 `weclaw-proxy` 的配置（均可省略）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 代理监听地址 |
| `port` | `9885` | 代理监听端口 |
| `upstreamHost` | `127.0.0.1` | 大圆网关地址 |
| `upstreamPort` | `9883` | 大圆网关端口 |
| `stallMs` | `100000` | 上游静默多久后主动断开重试 |
| `autoStart` | `true` | 为 `false` 时只探测不拉起代理 |
| `routes` | 内置 | 模型别名映射 |

## 使用

1. 启动大圆客户端并登录；
2. 安装本插件；
3. 在模型选择里选「企业微信大圆 · …」；
4. 若之前在 profile 里手工配过指向 `127.0.0.1:9885` 的 `weclaw` provider，请先删掉，否则 provider 重复声明会让宿主启动失败。

## 已知限制

- 仅 macOS：证书来自 `wecom-agent` 进程环境。
- 该端点 reasoning 占比很高，`maxTokens` 不要调太小，否则预算会被思考吃光、正文返回空串。
- 上游模型清单随租户权限变化，若新增模型需在 provider 的 `models` 里补条目并配好 `routes` 别名。
