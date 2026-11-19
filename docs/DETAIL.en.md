# dsh-weclaw

Bring the model quota of the WeCom "Dayuan" (大圆) desktop client into DeepSeek Harness.

## The problem

The Dayuan client runs a local model gateway at `https://127.0.0.1:9883` speaking OpenAI Chat
Completions, but its TLS handshake requires the mTLS client certificate held by `wecom-agent`.
DSH model adapters cannot present a client certificate, so pointing a provider at
`https://127.0.0.1:9883/v1` fails during the handshake.

This plugin does two things:

1. starts and stops a local plain-HTTP bridge at `http://127.0.0.1:9885` with the host, which
   re-originates every request to 9883 over mTLS;
2. declares a `weclaw` provider so "WeCom Dayuan" shows up in the model picker.

## Where the certificate comes from

The bridge reads no config file. It uses `pgrep` to find the running `wecom-agent` process and
`ps eww` to read `WECLAW_MTLS_CLIENT_CERT` / `WECLAW_MTLS_CLIENT_KEY` / `WECLAW_MTLS_CA_CERT`
from that process environment. The certificate stays in memory, refreshed every five minutes, so
a Dayuan restart that rotates the certificate needs no DSH restart.

The Dayuan client must therefore be **running**; otherwise the bridge has no certificate and
reports the upstream as unavailable.

## Upstream models wired up

The gateway picks a backend from the request `model` field, and the id it reports back is not
itself requestable. On the tenant tested:

| Picker entry | Upstream id | Input |
| --- | --- | --- |
| Dayuan · DeepSeek-V4.1-Flash | `MiniMax-M2.5-WW-128K-Test` | text |
| Dayuan · HY-Vision (text + image) | `HY-vision-1.5-instruct` | text + images |

The alias map is built in; override it with `WECLAW_ROUTES='{"alias":"upstream-id"}'`.

## Options

Configuration of the `weclaw-proxy` entry (all optional):

| Key | Default | Meaning |
| --- | --- | --- |
| `host` | `127.0.0.1` | bridge listen address |
| `port` | `9885` | bridge listen port |
| `upstreamHost` | `127.0.0.1` | Dayuan gateway address |
| `upstreamPort` | `9883` | Dayuan gateway port |
| `stallMs` | `100000` | drop and retry after this much upstream silence |
| `autoStart` | `true` | `false` probes only, never spawns the bridge |
| `routes` | built-in | model alias map |

## Usage

1. Start the Dayuan client and sign in.
2. Install this plugin.
3. Pick a "WeCom Dayuan · …" model.
4. The plugin appends the `weclaw` provider by overriding the stock `llm-pi-ai` entry; built-in
   providers survive the deep merge. A previously hand-configured copy can be deleted (harmless,
   just redundant).

## Limitations

- macOS only: the certificate lives in the `wecom-agent` process environment.
- Reasoning dominates this endpoint; keep `maxTokens` generous or answers come back empty.
- The upstream model list follows tenant permissions; new models need `models` entries plus
  `routes` aliases.
