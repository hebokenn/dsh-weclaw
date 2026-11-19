# dsh-weclaw

Use the model quota of the WeCom "Dayuan" (大圆) desktop client inside
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

[中文](README.md)

## How it works

The Dayuan client runs a local model gateway (`https://127.0.0.1:9883`) whose TLS handshake only
accepts an mTLS client certificate. DSH model adapters cannot present one, so the handshake fails.
This plugin runs a local plain-HTTP bridge (`http://127.0.0.1:9885`) inside the host: the bridge
reads the certificate from the environment of the running `wecom-agent` process, re-originates the
request over mTLS, and declares a `weclaw` provider for the model picker.

The certificate stays in memory, is refreshed every five minutes, and is never written to disk, so
a Dayuan restart that rotates it needs no DSH restart.

## Requirements

- macOS (the certificate lives in the `wecom-agent` process environment)
- The Dayuan client running and signed in
- DSH 0.x (the plugin declares itself through `dsh.bundle.patch`)

## Install

```sh
dsh plugin --profile desktop add "github:hebokenn/dsh-weclaw"
```

For local development, link a checkout directly:

```sh
dsh plugin --profile desktop add link:/path/to/dsh-weclaw
```

Then pick a "WeCom Dayuan · …" model in the model picker.

To make Dayuan the default model, add this to the profile's `cordis.patch.yml`:

```yaml
- id: agent-default-model
  config:
    provider: weclaw
    model: DeepSeek-V4.1-Flash-Agent-P800
```

> The plugin appends the `weclaw` provider by overriding the stock `llm-pi-ai` entry (deep merge
> keeps the built-in providers). If you previously hand-configured the same `weclaw` provider in
> your profile patch, you can delete that block — keeping it is merely redundant.

## Upstream models wired up

| Picker entry | Upstream id | Input |
| --- | --- | --- |
| Dayuan · DeepSeek-V4.1-Flash | `MiniMax-M2.5-WW-128K-Test` | text |
| Dayuan · HY-Vision (text + image) | `HY-vision-1.5-instruct` | text + images |

The gateway selects a backend from the request `model` and the id it reports back is not itself
requestable, so the bridge ships an alias map. Override it wholesale with
`WECLAW_ROUTES='{"alias":"upstream-id"}'`.

## Options

Configuration of the `weclaw-proxy` entry in `cordis.patch.yml`; every key is optional:

| Key | Default | Meaning |
| --- | --- | --- |
| `host` | `127.0.0.1` | bridge listen address |
| `port` | `9885` | bridge listen port |
| `upstreamHost` | `127.0.0.1` | Dayuan gateway address |
| `upstreamPort` | `9883` | Dayuan gateway port |
| `stallMs` | `100000` | drop and retry after this much upstream silence |
| `autoStart` | `true` | `false` probes only, never spawns the bridge |
| `routes` | built-in | model alias map |

## Troubleshooting

- `curl http://127.0.0.1:9885/healthz` should answer `{"ok":true,...}`; if it does not, the bridge
  never started — look for `[dsh-weclaw]` lines in the host log.
- `curl http://127.0.0.1:9885/v1/models` lists the catalog the bridge advertises.
- Empty answers with only reasoning: this endpoint spends most of its budget thinking, so keep
  `maxTokens` generous.
- Once Dayuan quits, requests report the upstream as unavailable; reopen Dayuan and the bridge
  refreshes the certificate by itself.

## License

MIT
