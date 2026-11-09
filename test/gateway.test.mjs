import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer, get } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { withGatewayClient } from '../src/client.mjs';
import { createRegistry, defaultConfigPath, readConfig } from '../src/config.mjs';
import { gatewayServer } from '../src/http.mjs';

const downstreamKey = 'test-client-key-fixture';
const upstreamKey = 'test-upstream-key-fixture';
const auth = { Authorization: 'Bearer ' + downstreamKey };

function childEnvironment(overrides) {
  const inherited = Object.entries(process.env).filter(([name]) => !/^(OH_MY_HARNESS_|OH_MY_DSH_|CLIPROXY_)/.test(name));
  return { ...Object.fromEntries(inherited), ...overrides };
}

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function listener(server, port = 0) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function fixture(t, configure = () => {}) {
  const scratch = await mkdtemp(path.join(tmpdir(), 'oh-my-harness-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const config = readConfig(defaultConfigPath);
  config.providers.example = {
    name: 'Example Messages', protocol: 'messages', capabilities: ['text', 'vision'],
    models: [{ id: 'example/assistant:latest', contextWindow: 32000, maxTokens: 4096 }],
  };
  configure(config);
  const calls = [];
  const upstream = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + upstreamKey) {
      res.writeHead(401);
      return res.end();
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ path: req.url, body, headers: req.headers });
    if (req.url === '/v1/models') {
      assert.equal(req.method, 'GET');
      return json(res, { data: Object.values(config.providers).flatMap((item) => item.models) });
    }
    if (req.url === '/v1/models/gpt-6.1-sol') {
      assert.equal(req.method, 'GET');
      return json(res, { id: 'gpt-6.1-sol' });
    }
    if (req.url === '/v1/messages/count_tokens') {
      assert.equal(req.headers['anthropic-version'], '2023-06-01');
      return json(res, { input_tokens: 9 });
    }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"delta":"working"}\n\n');
      return res.end('data: [DONE]\n\n');
    }
    if (req.url === '/v1/messages' && body.tools?.[0]?.type === 'web_search_20250305') {
      return json(res, { content: [
        { type: 'server_tool_use', id: 'search-1', name: 'web_search' },
        { type: 'web_search_tool_result', tool_use_id: 'search-1', content: [
          { type: 'web_search_result', url: 'https://www.example.com/article', title: 'Example' },
        ] },
        { type: 'text', text: 'Found one source.' },
      ] });
    }
    if (req.url === '/v1/messages') return json(res, { model: body.model, content: [{ type: 'text', text: 'Messages result' }] });
    if (req.url === '/v1/chat/completions') return json(res, { model: body.model, choices: [
      { finish_reason: 'stop', message: { content: body.response_format ? '{"answer":7}' : 'Chat result' } },
    ] });
    if (req.url === '/v1/responses') {
      const text = body.text?.format ? '{"answer":7}' : 'Responses result';
      const output = [{ type: 'message', content: [{ type: 'output_text', text }] }];
      if (body.tools?.[0]?.type === 'web_search') output.push({
        type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://www.example.com/article' },
      });
      return json(res, { model: body.model, status: 'completed', output });
    }
    res.writeHead(404);
    res.end();
  });
  const upstreamPort = await listener(upstream);
  t.after(() => upstream.close());
  config.upstream = `http://127.0.0.1:${upstreamPort}/v1`;
  const probe = createServer();
  config.listen.port = await listener(probe);
  await new Promise((resolve) => probe.close(resolve));
  config.listen.publicOrigin = 'https://gateway.example.com';
  const server = gatewayServer(config, downstreamKey, upstreamKey);
  const port = await listener(server, config.listen.port);
  t.after(() => server.close());
  return { mcpURL: new URL(`http://127.0.0.1:${port}/mcp`), modelURL: new URL(config.upstream + '/'), calls, scratch };
}

const answer = (result) => {
  assert.equal(result.isError ?? false, false, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};

test('registry selects provider by declared capability and exact model alias', () => {
  const config = readConfig(defaultConfigPath);
  const registry = createRegistry(config);
  assert.equal(registry.select('text').id, 'codex');
  assert.equal(registry.select('text', undefined, 'kimi-k3').protocol, 'chat');
  assert.throws(() => registry.select('audio', 'kimi'), /support audio/);
  assert.throws(() => registry.select('text', 'kimi', 'gpt-6.1-sol'), /configured provider and model/);
  config.providers.kimi.models.push(config.providers.codex.models[0]);
  assert.throws(() => createRegistry(config), /unique/);
});

test('Capability Proxy and model API expose separate routes and client credentials', async (t) => {
  const { mcpURL, modelURL, calls } = await fixture(t);
  assert.equal((await fetch(mcpURL)).status, 401);
  assert.equal((await fetch(mcpURL, { headers: { Authorization: 'Bearer ' + upstreamKey } })).status, 401);
  assert.equal((await fetch(mcpURL, { headers: { ...auth, Origin: 'https://www.example.com' } })).status, 403);
  assert.equal((await fetch(new URL('/v1/models', mcpURL), { headers: auth })).status, 404);
  assert.equal((await fetch(new URL('/v1/responses', mcpURL), { method: 'POST', headers: auth, body: '{}' })).status, 404);
  assert.equal((await fetch(new URL('/v8/management/config', mcpURL), { headers: auth })).status, 404);
  assert.equal(calls.length, 0);
  const proxied = await new Promise((resolve, reject) => {
    get(new URL('/healthz', mcpURL), { headers: { Host: 'GATEWAY.EXAMPLE.COM:443', Origin: 'https://gateway.example.com' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(proxied, 204);
  assert.equal((await fetch(new URL('models', modelURL), { headers: auth })).status, 401);
  const stream = await fetch(new URL('responses', modelURL), {
    method: 'POST', headers: { Authorization: 'Bearer ' + upstreamKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-6.1-sol', input: 'test', stream: true }),
  });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  assert.match(await stream.text(), /data: \[DONE\]/);
});

test('HTTP MCP advertises capability tools, dispatches three protocols and keeps search evidence', async (t) => {
  const { mcpURL, calls } = await fixture(t);
  await withGatewayClient(mcpURL, downstreamKey, async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name).sort(), [
      'ask_audio', 'edit_image', 'generate_image', 'inspect_document', 'inspect_image', 'inspect_video',
      'list_providers', 'synthesize_speech', 'transcribe_audio', 'web_search',
    ]);
    const call = async (name, args) => answer(await client.callTool({ name, arguments: args }));
    const { providers } = await call('list_providers', {});
    assert.ok(providers.every((item) => !item.capabilities.includes('text')));
    const image = {
      image_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP2sAAAAASUVORK5CYII=',
      question: 'What is visible?',
    };
    assert.equal((await call('inspect_image', image)).answer, 'Responses result');
    assert.equal((await call('inspect_image', { ...image, model: 'kimi-k3' })).answer, 'Chat result');
    assert.equal((await call('inspect_image', { ...image, provider: 'example' })).answer, 'Messages result');
    assert.equal(calls.at(-1).body.model, 'example/assistant:latest');
    assert.equal(calls.at(-1).headers['anthropic-version'], '2023-06-01');
    const page = await call('web_search', { query: 'read page', url: 'https://www.example.com/article' });
    assert.equal(page.actions[0].url, 'https://www.example.com/article');
    const search = await call('web_search', { provider: 'kimi', query: 'find sources' });
    assert.deepEqual(search.sources, [{ url: 'https://www.example.com/article', title: 'Example' }]);
    assert.equal(calls.at(-1).body.tool_choice.name, 'web_search');
  });
});

test('optional model tools preserve legacy names and route by configured model', async (t) => {
  const { mcpURL, calls } = await fixture(t, (config) => {
    config.modelTools = true;
    config.providers.codex.tokenSource = 'proxy_estimate';
    config.providers.codex.modelToolAliases = ['codex-auto-review'];
    config.providers.kimi.tokenSource = 'provider_count';
  });
  await withGatewayClient(mcpURL, downstreamKey, async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name).sort(), [
      'ask_audio', 'count_input_tokens', 'edit_image', 'generate_image', 'generate_structured',
      'generate_text', 'get_model', 'inspect_document', 'inspect_image', 'inspect_video',
      'list_models', 'list_providers', 'synthesize_speech', 'transcribe_audio', 'web_search',
    ]);
    const call = (name, args) => client.callTool({ name, arguments: args });
    assert.equal(answer(await call('get_model', { model: 'gpt-6.1-sol' })).id, 'gpt-6.1-sol');
    assert.equal(answer(await call('list_models', {})).models.length, 3);
    assert.equal(answer(await call('generate_text', { model: 'codex-auto-review', prompt: 'test' })).answer, 'Responses result');
    assert.equal(calls.at(-1).body.model, 'codex-auto-review');
    const schema = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false };
    for (const [model, route, expected, source] of [
      ['gpt-6.1-sol', '/v1/responses', 'Responses result', 'proxy_estimate'],
      ['kimi-k3', '/v1/chat/completions', 'Chat result', 'provider_count'],
    ]) {
      const args = { model, prompt: 'Return the answer.' };
      assert.equal(answer(await call('generate_text', args)).answer, expected);
      assert.equal(calls.at(-1).path, route);
      assert.deepEqual(answer(await call('generate_structured', { ...args, schema })).data, { answer: 7 });
      assert.equal(calls.at(-1).path, route);
      assert.deepEqual(answer(await call('count_input_tokens', args)), { model, input_tokens: 9, source });
    }
    const before = calls.length;
    assert.equal((await call('generate_text', { model: 'not-configured', prompt: 'test' })).isError, true);
    assert.equal((await call('generate_structured', { model: 'gpt-6.1-sol', prompt: 'test', schema: { ...schema, additionalProperties: true } })).isError, true);
    assert.equal(calls.length, before);
  });
});

test('init keeps OAuth and other keys when splitting credentials, including on retry', async (t) => {
  const state = await mkdtemp(path.join(tmpdir(), 'oh-my-harness-state-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const proxyFile = path.join(state, 'cliproxyapi.yaml');
  const gatewayFile = path.join(state, 'gateway.key');
  const modelFile = path.join(state, 'model.key');
  const authDir = path.join(state, 'existing-oauth');
  await writeFile(gatewayFile, downstreamKey, { mode: 0o600 });
  await writeFile(proxyFile, JSON.stringify({
    access: { 'api-keys': [downstreamKey, upstreamKey] },
    oauth: { 'auth-dir': authDir },
  }), { mode: 0o600 });
  const env = childEnvironment({ OH_MY_DSH_STATE_DIR: state });
  const run = promisify(execFile);
  const init = (provider = 'kimi') => run(process.execPath, ['bin/oh-my-harness.mjs', 'init', '--provider', provider], { env });
  await init();
  const modelKey = (await readFile(modelFile, 'utf8')).trim();
  const config = JSON.parse(await readFile(proxyFile, 'utf8'));
  assert.notEqual(modelKey, downstreamKey);
  assert.deepEqual(config.access['api-keys'], [upstreamKey, modelKey]);
  assert.equal(config.oauth['auth-dir'], authDir);
  await init();
  assert.equal((await readFile(modelFile, 'utf8')).trim(), modelKey);
  assert.equal(await readFile(gatewayFile, 'utf8'), downstreamKey);
  assert.deepEqual(JSON.parse(await readFile(proxyFile, 'utf8')), config);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(state, 'config.json'), 'utf8')).providers), ['kimi']);
  await assert.rejects(init('codex'), /different provider configuration/);
});

test('stored model tool settings do not affect capability routing', async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'oh-my-harness-registry-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const file = path.join(scratch, 'config.json');
  const old = readConfig(defaultConfigPath);
  old.providers.codex.capabilities.push('structured', 'tokens');
  old.providers.codex.tokenSource = 'proxy_estimate';
  old.defaults.structured = 'former-provider';
  old.defaults.tokens = 'codex';
  await writeFile(file, JSON.stringify(old));
  const config = readConfig(file);
  assert.deepEqual(config, readConfig(defaultConfigPath));
});

test('DSH profile uses the origin for Messages and keeps raw client keys out of the profile', async (t) => {
  const state = await mkdtemp(path.join(tmpdir(), 'oh-my-harness-dsh-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const configPath = path.join(state, 'config.json');
  const config = readConfig(defaultConfigPath);
  config.providers.example = {
    name: 'Messages fixture', protocol: 'messages', capabilities: ['text'],
    models: [{ id: 'example/messages', contextWindow: 32000, maxTokens: 4096 }],
  };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(path.join(state, 'model.key'), upstreamKey, { mode: 0o600 });
  await writeFile(path.join(state, 'gateway.key'), downstreamKey, { mode: 0o600 });
  await mkdir(path.join(state, 'workspace'));
  await writeFile(path.join(state, 'workspace', 'web'), '');
  const env = childEnvironment({
    OH_MY_HARNESS_STATE_DIR: state,
    OH_MY_HARNESS_DSH_BIN: process.execPath,
    OH_MY_HARNESS_MODEL_URL: 'https://models.example.com/v1',
    OH_MY_HARNESS_MCP_URL: 'https://tools.example.com/mcp',
  });
  await promisify(execFile)(process.execPath, ['bin/oh-my-harness.mjs', 'dsh'], { env });
  const profile = await readFile(path.join(state, 'dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
  assert.ok(!profile.includes(upstreamKey) && !profile.includes(downstreamKey));
  const entries = JSON.parse(profile);
  const { providers } = entries.find((item) => item.id === 'llm-pi-ai').config;
  assert.equal(providers.example.baseURL, 'https://models.example.com');
  assert.equal(providers.codex.baseURL, 'https://models.example.com/v1');
  assert.equal(providers.kimi.baseURL, 'https://models.example.com/v1');
  const mcp = entries.find((item) => item.insert).insert[0].config;
  assert.equal(mcp.env.OH_MY_HARNESS_MCP_URL, 'https://tools.example.com/mcp');
  assert.equal(mcp.env.OH_MY_HARNESS_KEY_FILE, path.join(state, 'gateway.key'));
});

test('init for an external model proxy creates only local capability credentials', async (t) => {
  const state = await mkdtemp(path.join(tmpdir(), 'oh-my-harness-external-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const file = path.join(state, 'external.json');
  const config = readConfig(defaultConfigPath);
  config.upstream = 'https://models.example.com/v1';
  await writeFile(file, JSON.stringify(config));
  const env = childEnvironment({ OH_MY_HARNESS_STATE_DIR: state, OH_MY_HARNESS_CONFIG: file });
  await promisify(execFile)(process.execPath, ['bin/oh-my-harness.mjs', 'init'], { env });
  assert.match((await readFile(path.join(state, 'gateway.key'), 'utf8')).trim(), /^[a-f0-9]{64}$/);
  await assert.rejects(readFile(path.join(state, 'model.key')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(state, 'cliproxyapi.yaml')), { code: 'ENOENT' });
});

test('DSH stdio presents file arguments and keeps inputs inside its artifact directory', async (t) => {
  const { mcpURL, scratch, calls } = await fixture(t);
  const keyPath = path.join(scratch, 'gateway.key');
  const artifacts = path.join(scratch, 'artifacts');
  await writeFile(keyPath, downstreamKey, { mode: 0o600 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/stdio.mjs'],
    env: childEnvironment({ OH_MY_HARNESS_MCP_URL: mcpURL.href, OH_MY_HARNESS_KEY_FILE: keyPath, OH_MY_HARNESS_ARTIFACT_DIR: artifacts }),
    stderr: 'inherit',
  });
  const client = new Client({ name: 'test-dsh', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  const doc = tools.find((tool) => tool.name === 'inspect_document');
  assert.ok(doc.inputSchema.properties.file);
  assert.equal(doc.inputSchema.properties.file_base64, undefined);
  const csv = 'name,total\nexample,3\n';
  await writeFile(path.join(artifacts, 'sample.csv'), csv);
  const result = await client.callTool({ name: 'inspect_document', arguments: { file: 'sample.csv', question: 'total?' } });
  assert.equal(answer(result).answer, 'Responses result');
  const parts = calls.at(-1).body.input[0].content;
  assert.equal(parts[0].filename, 'sample.csv');
  assert.equal(parts[0].file_data, 'data:text/csv;base64,' + Buffer.from(csv).toString('base64'));
  await symlink(keyPath, path.join(artifacts, 'escape.csv'));
  const rejected = await client.callTool({ name: 'inspect_document', arguments: { file: 'escape.csv', question: 'read?' } });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /inside/);
});
