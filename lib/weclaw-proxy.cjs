#!/usr/bin/env node
'use strict';

/**
 * weclaw-proxy — expose the WeCom "大圆" local model gateway as a plain
 * OpenAI-compatible endpoint for DSH.
 *
 * Why: 127.0.0.1:9883 speaks OpenAI Chat Completions but requires the
 * weclaw-agent mTLS client certificate during the TLS handshake. DSH's
 * llm-pi-ai provider cannot present a client certificate, so this process
 * terminates plain HTTP locally and re-originates the request over mTLS.
 *
 * The certificate, key and CA are read from the environment of the running
 * wecom-agent process (ps eww). They are kept in memory only, never on disk.
 * When WeCom restarts it rotates the certificate; the cache is refreshed on a
 * timer and on any upstream failure.
 */

const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const PORT = Number(process.env.WECLAW_PROXY_PORT || 9885);
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 9883;
// The gateway picks a backend from the request `model` field, and the id it
// reports back is not itself requestable. Every id DSH can select is therefore
// mapped onto an upstream id the tenant can actually reach. Verified against a
// live client: MiniMax-M2.5-WW-128K-Test (text) and HY-vision-1.5-instruct
// (text + images) answer; DeepSeek-V4.1-Flash-Agent-P800, HY-Vision-2.0-instruct
// and other guesses return -10007 No available resource. Vision 1.5 is the only
// image route: a 2.0 request for the same body fails with -3007 upstream_error.
// Override the whole map
// with WECLAW_ROUTES='{"alias":"upstream-id",...}' when an upstream renames.
const DEFAULT_ROUTES = {
  'DeepSeek-V4.1-Flash-Agent-P800': 'MiniMax-M2.5-WW-128K-Test',
  'HY-vision-1.5-instruct': 'HY-vision-1.5-instruct',
};
const REQUEST_MODEL = process.env.WECLAW_REQUEST_MODEL || 'MiniMax-M2.5-WW-128K-Test';

function log(...args) {
  console.error(new Date().toISOString(), ...args);
}

function parseRoutes(raw) {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not an object');
    const out = {};
    for (const [k, v] of Object.entries(j)) if (typeof v === 'string' && v) out[k] = v;
    return Object.keys(out).length ? out : null;
  } catch (e) {
    log('WECLAW_ROUTES ignored:', e.message);
    return null;
  }
}

let ROUTES = parseRoutes(process.env.WECLAW_ROUTES) || { ...DEFAULT_ROUTES };

const CERT_TTL_MS = 5 * 60 * 1000;
const MAX_BODY = 32 * 1024 * 1024;
const MAX_RETRIES = 2;
// A silent upstream (accepted the request, then sent nothing) must not hold the
// client for DSH's 300s stream idle timeout. Retry well before that.
const STALL_MS = Number(process.env.WECLAW_STALL_MS || 100000);
const UPSTREAM_TIMEOUT_MS = 5 * 60 * 1000;

let certState = null;

function findAgentPid() {
  try {
    const out = execFileSync(
      'pgrep',
      ['-f', 'WeComAgentAssistant.app/Contents/MacOS/wecom-agent'],
      { encoding: 'utf8' },
    );
    for (const s of out.split(/\s+/)) if (/^\d+$/.test(s)) return Number(s);
  } catch {}
  return null;
}

function extractPem(env, label, endRe) {
  const re = new RegExp(label + '=([\\s\\S]*?' + endRe + ')');
  const m = env.match(re);
  if (!m) return null;
  const pem = m[1].replace(/\\012/g, '\n').replace(/\\n/g, '\n').trim();
  if (!pem.startsWith('-----BEGIN')) return null;
  return pem + '\n';
}

function loadCerts(force) {
  if (!force && certState && Date.now() - certState.at < CERT_TTL_MS) return certState;
  const pid = findAgentPid();
  if (!pid) throw new Error('wecom-agent 进程未运行');
  const env = execFileSync('ps', ['eww', '-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const cert = extractPem(env, 'WECLAW_MTLS_CLIENT_CERT', '-----END CERTIFICATE-----');
  const key = extractPem(env, 'WECLAW_MTLS_CLIENT_KEY', '-----END (?:RSA )?PRIVATE KEY-----');
  const ca = extractPem(env, 'WECLAW_MTLS_CA_CERT', '-----END CERTIFICATE-----');
  if (!cert || !key || !ca) throw new Error('wecom-agent 环境变量中缺少 mTLS 证书');
  certState = { cert, key, ca, at: Date.now(), pid };
  log('certs loaded from agent pid', pid);
  return certState;
}

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
}

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  cors(res);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
  });
  res.end(buf);
}

// The 9883 gateway rejects these OpenAI parameters with aigw_ret -400008
// ("Unknown or unsupported request parameter"), so never forward them.
const UNSUPPORTED_PARAMS = [
  'store',
  'prompt_cache_key',
  'prompt_cache_retention',
  'parallel_tool_calls',
  'metadata',
  'service_tier',
];

function normalizeBody(body, req) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.includes('application/json')) return body;
  try {
    const j = JSON.parse(body.toString('utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return body;
    let changed = false;
    if (typeof j.model === 'string') {
      const upstream = ROUTES[j.model] || REQUEST_MODEL;
      if (j.model !== upstream) {
        j.model = upstream;
        changed = true;
      }
    }
    for (const key of UNSUPPORTED_PARAMS) {
      if (key in j) {
        delete j[key];
        changed = true;
      }
    }
    return changed ? Buffer.from(JSON.stringify(j)) : body;
  } catch {}
  return body;
}

function forward(req, res, body, attempt) {
  let settled = false;
  body = normalizeBody(body, req);
  log('start', req.url, 'attempt', attempt, 'bytes', body.length);
  let certs;
  try {
    certs = loadCerts(attempt > 0);
  } catch (e) {
    return sendJson(res, 503, {
      error: { message: 'weclaw proxy: ' + e.message, type: 'proxy_error', code: 'CERT_UNAVAILABLE' },
    });
  }

  let isStream = false;
  try {
    isStream = JSON.parse(body.toString('utf8')).stream === true;
  } catch {}

  const headers = {
    'content-type': req.headers['content-type'] || 'application/json',
    accept: req.headers.accept || (isStream ? 'text/event-stream' : 'application/json'),
    'content-length': body.length,
  };
  if (req.headers.authorization) headers.authorization = req.headers.authorization;

  const up = https.request({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    path: req.url,
    method: req.method,
    headers,
    cert: certs.cert,
    key: certs.key,
    ca: certs.ca,
    rejectUnauthorized: true,
  });

  const finishWithError = (message) => {
    if (settled) return;
    settled = true;
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: { message: 'weclaw upstream: ' + message, type: 'server_error', code: -10007 },
      });
    } else {
      try { res.end(); } catch {}
    }
  };

  const retry = (reason) => {
    if (settled) return;
    settled = true;
    if (attempt < MAX_RETRIES) {
      log('retry', attempt + 1, reason);
      setTimeout(() => forward(req, res, body, attempt + 1), 1200 + attempt * 800);
    } else {
      finishWithError(reason);
    }
  };

  const timer = setTimeout(() => up.destroy(new Error('upstream timeout')), UPSTREAM_TIMEOUT_MS);
  up.on('error', (err) => {
    clearTimeout(timer);
    if (settled) return;
    if (res.headersSent) {
      settled = true;
      try { res.end(); } catch {}
      return;
    }
    retry(err.message);
  });

  up.on('response', (upRes) => {
    if (!isStream) {
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        clearTimeout(timer);
        if (settled) return;
        const buf = Buffer.concat(chunks);
        const status = upRes.statusCode || 502;
        const text = buf.toString('utf8');
        if ((status >= 500 || /"error"\s*:/.test(text.slice(0, 600))) && attempt < MAX_RETRIES) {
          return retry('upstream error body (status ' + status + ')');
        }
        settled = true;
        cors(res);
        res.writeHead(status, {
          'content-type': upRes.headers['content-type'] || 'application/json; charset=utf-8',
          'content-length': buf.length,
        });
        res.end(buf);
      });
      upRes.on('error', () => {});
      return;
    }

    let buf = Buffer.alloc(0);
    let decided = false;
    const firstTimer = setTimeout(() => {
      if (decided || settled) return;
      log('stall', 'no first byte in ' + STALL_MS + 'ms, attempt', attempt + 1);
      retry('no first byte');
      up.destroy();
    }, STALL_MS);

    function decide() {
      if (decided || settled) return;
      decided = true;
      clearTimeout(firstTimer);
      const text = buf.toString('utf8');
      if (/"error"\s*:/.test(text) && attempt < MAX_RETRIES) {
        clearTimeout(timer);
        up.destroy();
        return retry('sse error event');
      }
      settled = true;
      cors(res);
      const h = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        const lk = k.toLowerCase();
        if (lk === 'transfer-encoding' || lk === 'connection' || lk === 'keep-alive') continue;
        h[k] = v;
      }
      res.writeHead(upRes.statusCode || 200, h);
      if (buf.length) res.write(buf);
      upRes.on('data', (c) => {
        if (!res.write(c)) upRes.pause();
      });
      res.on('drain', () => upRes.resume());
      upRes.on('end', () => {
        clearTimeout(timer);
        res.end();
      });
    }

    upRes.on('data', (c) => {
      if (decided) return;
      buf = Buffer.concat([buf, c]);
      if (buf.includes('\n\n') || buf.length > 8192) decide();
    });
    upRes.on('end', () => {
      clearTimeout(firstTimer);
      if (settled) return;
      if (!decided) decide();
      else {
        clearTimeout(timer);
        res.end();
      }
    });
    upRes.on('error', () => {
      clearTimeout(firstTimer);
      if (settled) return;
      if (!decided) decide();
    });
  });

  res.on('close', () => {
    if (!res.writableEnded) up.destroy();
  });

  up.end(body);
}

const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      return res.end();
    }
    if (u.pathname === '/healthz') {
      return sendJson(res, 200, {
        ok: true,
        agentPid: certState ? certState.pid : null,
        certAgeSec: certState ? Math.round((Date.now() - certState.at) / 1000) : null,
        upstream: 'https://' + UPSTREAM_HOST + ':' + UPSTREAM_PORT,
      });
    }
    if (u.pathname === '/v1/models' && req.method === 'GET') {
      const data = Object.keys(ROUTES).map((id) => ({ id, object: 'model', owned_by: 'wecom' }));
      return sendJson(res, 200, { object: 'list', data });
    }
    if (!u.pathname.startsWith('/v1/')) {
      return sendJson(res, 404, { error: { message: 'not found' } });
    }
    const started = Date.now();
    res.on('finish', () => {
      log('req', req.method, u.pathname, res.statusCode, Date.now() - started + 'ms');
    });
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => forward(req, res, Buffer.concat(chunks), 0));
    req.on('error', () => {});
  } catch (e) {
    sendJson(res, 500, { error: { message: String((e && e.message) || e) } });
  }
});

try {
  loadCerts();
} catch (e) {
  log('cert warmup failed:', e.message);
}

server.listen(PORT, '127.0.0.1', () => {
  log('weclaw-proxy listening on http://127.0.0.1:' + PORT);
});

setInterval(() => {
  try {
    loadCerts(true);
  } catch (e) {
    log('cert refresh failed:', e.message);
  }
}, CERT_TTL_MS).unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000);
  });
}
