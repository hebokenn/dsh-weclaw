/**
 * dsh-weclaw — DSH host plugin.
 *
 * Two jobs:
 *   1. keep the local plain-HTTP bridge to the WeCom "大圆" mTLS model gateway
 *      alive (spawn `lib/weclaw-proxy.cjs` once per host, reuse it if it is
 *      already listening);
 *   2. nothing else — the `weclaw` LLM provider itself is declared
 *      declaratively by `cordis.patch.yml` as an `@deepseek-ai/dsh-llm-pi-ai`
 *      entry, so no official package has to be imported here.
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-weclaw'

// lib/index.js -> package root, so the bundle stays relocatable when it is
// installed into <profile>/node_modules or linked from a checkout.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROXY_SCRIPT = path.join(PACKAGE_ROOT, 'lib', 'weclaw-proxy.cjs')

const DEFAULTS = {
  host: '127.0.0.1',
  port: 9885,
  upstreamHost: '127.0.0.1',
  upstreamPort: 9883,
  stallMs: 100000,
  startTimeoutMs: 20000,
}

function log(...args) {
  console.log('[dsh-weclaw]', ...args)
}

function probe(host, port, timeoutMs = 1200) {
  return new Promise(resolve => {
    const req = http.get({ host, port, path: '/healthz', timeout: timeoutMs }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        try {
          const json = JSON.parse(body)
          resolve(json && json.ok ? json : null)
        } catch {
          resolve(null)
        }
      })
    })
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.on('error', () => resolve(null))
  })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const { host, port } = options
  let child = null
  let disposed = false

  const start = async () => {
    const existing = await probe(host, port)
    if (existing) {
      log(`bridge already listening on http://${host}:${port} (agent pid ${existing.agentPid}) — reusing it`)
      return
    }
    if (options.autoStart === false) {
      log(`bridge not listening on http://${host}:${port} and autoStart is disabled`)
      return
    }

    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WECLAW_PROXY_PORT: String(port),
      WECLAW_UPSTREAM_HOST: String(options.upstreamHost),
      WECLAW_UPSTREAM_PORT: String(options.upstreamPort),
      WECLAW_STALL_MS: String(options.stallMs),
    }
    if (options.routes && typeof options.routes === 'object') {
      env.WECLAW_ROUTES = JSON.stringify(options.routes)
    }

    log(`starting bridge: ${PROXY_SCRIPT} on ${host}:${port}`)
    child = spawn(process.execPath, [PROXY_SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { for (const line of chunk.split('\n')) if (line.trim()) log(line.trim()) })
    child.stderr.on('data', chunk => { for (const line of chunk.split('\n')) if (line.trim()) log(line.trim()) })
    child.on('exit', (code, signal) => {
      if (disposed) return
      log(`bridge exited (code=${code}, signal=${signal})`)
      child = null
    })

    const deadline = Date.now() + options.startTimeoutMs
    while (!disposed && Date.now() < deadline) {
      const health = await probe(host, port, 800)
      if (health) {
        log(`bridge ready on http://${host}:${port} (agent pid ${health.agentPid})`)
        return
      }
      if (!child) break
      await sleep(250)
    }
    if (!disposed && child) log(`bridge did not answer /healthz within ${options.startTimeoutMs}ms`)
  }

  const ready = start().catch(error => {
    log(`failed to start bridge: ${error && error.message ? error.message : error}`)
  })

  return async () => {
    disposed = true
    await ready
    if (!child) return
    const dying = child
    child = null
    log('stopping bridge')
    dying.kill('SIGTERM')
    await sleep(400)
    if (!dying.killed) dying.kill('SIGKILL')
  }
}

export default { name, apply }
