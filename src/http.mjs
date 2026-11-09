import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createRegistry, endpoint } from './config.mjs';
import { createTools, requestUpstream } from './tools.mjs';
import { registerRealtimeTools } from './realtime.mjs';
import { registerModelTools } from './model-tools.mjs';

const bodyLimit = 8 * 1024 * 1024;
function reject(res, status, message) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...(status === 401 ? { 'WWW-Authenticate': 'Bearer realm="oh-my-harness"' } : {}),
  });
  res.end(JSON.stringify({ error: { message } }));
}

async function readBody(req) {
  if (Number(req.headers['content-length']) > bodyLimit) {
    req.resume();
    return;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > bodyLimit) {
      req.resume();
      return;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function relay(response, res) {
  const headers = { 'Cache-Control': 'no-store' };
  for (const key of ['content-type', 'mcp-protocol-version', 'mcp-session-id', 'retry-after', 'www-authenticate']) {
    const value = response.headers.get(key);
    if (value) headers[key] = value;
  }
  res.writeHead(response.status, headers);
  if (response.body) await pipeline(Readable.fromWeb(response.body), res);
  else res.end();
}

export function gatewayServer(config, key, upstreamKey) {
  if (!key || !upstreamKey || key === upstreamKey) throw new Error('Use distinct capability and upstream keys');
  const registry = createRegistry(config);
  const upstream = endpoint(config.upstream, 'api');
  const listener = config.listen;
  const local = new URL(`http://127.0.0.1:${listener.port}`);
  const origins = new Map([
    [local.host, local.origin],
    [`localhost:${listener.port}`, `http://localhost:${listener.port}`],
  ]);
  if (listener.publicOrigin) {
    const publicURL = endpoint(listener.publicOrigin, 'public');
    origins.set(publicURL.host, publicURL.origin);
    if (!publicURL.port) origins.set(`${publicURL.host}:443`, publicURL.origin);
  }
  const expected = Buffer.from(key);
  const mcp = createMcpHandler(({ requestInfo }) => {
    const gateway = (route, payload, timeout, signal) => requestUpstream(upstream, upstreamKey, route, payload, timeout,
      AbortSignal.any([requestInfo.signal, ...(signal ? [signal] : [])]));
    const server = createTools({ registry, gateway });
    if (config.modelTools) registerModelTools(server, { registry, gateway });
    registerRealtimeTools(server, { upstream, token: upstreamKey, registry, requestSignal: requestInfo.signal });
    return server;
  }, { maxRequestBodySize: bodyLimit, maxSubscriptions: 5 });

  let active = 0;
  async function serve(req, res) {
    const origin = origins.get(req.headers.host?.toLowerCase());
    if (!origin || (req.headers.origin && req.headers.origin !== origin)) return reject(res, 403, 'Origin or host is not allowed');
    if (req.url === '/healthz' && req.method === 'GET') {
      res.writeHead(204);
      return res.end();
    }
    if (req.url !== '/mcp') return reject(res, 404, 'Route not found');
    const token = /^Bearer ([^\s,]+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const supplied = typeof token === 'string' ? Buffer.from(token) : Buffer.alloc(0);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reject(res, 401, 'Capability Proxy key required');
    if (active >= listener.maxConcurrentRequests) return reject(res, 429, 'Too many active requests');
    active++;
    try {
      const abort = new AbortController();
      res.once('close', () => { if (!res.writableFinished) abort.abort(); });
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(190_000)]);
      const body = await readBody(req);
      if (!body) return reject(res, 413, 'Request exceeds 8 MiB');
      const request = new Request(origin + '/mcp', {
        method: req.method, headers: req.headers, signal,
        ...(body.length ? { body } : {}),
      });
      return await relay(await mcp.fetch(request, { authInfo: { token: key, clientId: 'gateway', scopes: [] } }), res);
    } finally {
      active--;
    }
  }

  return createServer((req, res) => {
    serve(req, res).catch(() => {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else reject(res, 502, 'Gateway request failed');
    });
  });
}
