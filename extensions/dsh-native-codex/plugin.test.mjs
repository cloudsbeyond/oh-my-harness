import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import path from 'node:path';
import { upstreamAdapter, stateRoot } from './paths.mjs';
const entry = process.env.NATIVE_TEST_RELEASE === '1'
  ? JSON.parse(await readFile(new URL('release-manifest.json', stateRoot), 'utf8')).entry
  : new URL('./plugin.mjs', import.meta.url).href;
const { createAdapter, validateConfig, apply } = await import(entry);
const expectedHash = '99b5c20830a52f69641df8a18a39206079b0c725201958cce2c4a934f1d4f7cd';
const upstreamPath = path.join(upstreamAdapter, 'lib/index.js');

const route = 'codex';
function config(baseURL = 'http://127.0.0.1:8317/v1', nativeSearch = {}) {
  return {
    nativeSearch: { enabled: true, ...nativeSearch },
    providers: {
      [route]: {
        displayName: 'Codex Native Search', api: 'openai-responses', baseURL,
        apiKeyEnv: 'TEST_NATIVE_KEY', timeoutMs: 5000, streamIdleTimeoutMs: 5000,
        retryPolicy: { mode: 'normal', maxRetries: 0 },
        models: [{ id: 'test-native', name: 'Native test', contextWindow: 32768, maxTokens: 2048, reasoningEfforts: false, input: ['text', 'image'] }],
        compat: { supportsMaxOutputTokens: false },
      },
    },
  };
}
const ctx = {
  get(name) {
    if (name === 'credentials') return { resolve: async () => ({ value: 'local-test-only' }), listRecords: async () => [], readRecord: async () => undefined };
  },
  logger: { warn() {}, info() {} },
};
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
function responseEvents(output, id = 'resp_test') {
  const response = { id, object: 'response', created_at: 1, model: 'test-native', status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
  const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }];
  output.forEach((item, output_index) => {
    events.push({ type: 'response.output_item.added', output_index, item });
    events.push({ type: 'response.output_item.done', output_index, item });
  });
  events.push({ type: 'response.completed', response });
  return events;
}
const searchItem = { type: 'web_search_call', id: 'ws_test', status: 'completed', action: { type: 'search', query: 'DSH test', sources: [{ type: 'url', url: 'https://example.com/docs', title: 'Example docs' }] } };
const answerItem = { type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Verified answer.', annotations: [{ type: 'url_citation', start_index: 0, end_index: 8, title: 'Example docs', url: 'https://example.com/docs' }] }] };
async function serverFor(t, replies) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const part of req) raw += part;
      requests.push({ path: req.url, headers: req.headers, body: JSON.parse(raw) });
      const events = replies[Math.min(requests.length - 1, replies.length - 1)];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { requests, baseURL: `http://127.0.0.1:${server.address().port}/v1` };
}
async function run(adapter, messages, extra = {}) {
  const assembler = new BlockAssembler();
  const chunks = [];
  for await (const chunk of adapter.stream({ provider: route, model: 'test-native', messages, ...extra })) { chunks.push(chunk); assembler.push(chunk); }
  return { chunks, assembler, message: assembler.message({ provider: route, model: 'test-native', replayState: assembler.replayState }) };
}

test('configuration defaults auxiliary search off and rejects unsupported knobs/endpoints', () => {
  assert.equal(validateConfig(config()).policy.allowAuxiliary, false);
  assert.equal(validateConfig(config()).profiles.get(route).api, 'openai-responses');
  assert.throws(() => validateConfig({ ...config(), nativeTools: [] }), /Unknown/);
  assert.equal(validateConfig(config('https://gateway.example.com/v1')).profiles.get(route).baseURL, 'https://gateway.example.com/v1');
  assert.throws(() => validateConfig(config('http://gateway.example.com/v1')), /local HTTP/);
  assert.throws(() => validateConfig(config('http://127.0.0.1:8317/backend-api')), /\/v1/);
  assert.throws(() => validateConfig(config(undefined, { enabled: 'yes' })), /boolean/);
  assert.throws(() => validateConfig(config(undefined, { maxSources: 0 })), /maxSources/);
  const current = config();
  assert.deepEqual([...validateConfig(current).profiles.keys()], [route]);
});

test('registration owns the existing Codex route and preserves the installed adapter fingerprint', async () => {
  let registration;
  await apply({ ...ctx, llm: { registerAdapter(routes, adapter) { registration = { routes, adapter }; } } }, config());
  assert.deepEqual(registration.routes, [route]);
  assert.deepEqual((await registration.adapter.listModels(route)).map(({ id }) => id), ['test-native']);
  assert.equal(typeof registration.adapter.stream, 'function');
  assert.equal(createHash('sha256').update(await readFile(upstreamPath)).digest('hex'), expectedHash);
});

test('native search reaches wire, sources are durable, and next turn replays native items', async (t) => {
  const mock = await serverFor(t, [responseEvents([searchItem, answerItem]), responseEvents([{ ...answerItem, id: 'msg_next' }], 'resp_next')]);
  const { adapter } = createAdapter(ctx, config(mock.baseURL));
  const first = await run(adapter, [user('Search a test source.')], { tools: [{ name: 'read_local', description: 'Read a local file', parameters: { type: 'object', properties: {} } }] });
  assert.equal(first.assembler.finish.kind, 'stop');
  assert.equal(mock.requests[0].path, '/v1/responses');
  const payload = mock.requests[0].body;
  assert.ok(payload.tools.some((item) => item.type === 'web_search'));
  assert.ok(payload.tools.some((item) => item.type === 'function' && item.name === 'read_local'));
  assert.ok(payload.include.includes('web_search_call.action.sources'));
  assert.equal(payload.tool_choice.type, 'allowed_tools');
  assert.ok(!payload.tool_choice.tools.some((item) => item.type === 'image_generation'));
  assert.ok(mock.requests[0].headers['authorization'] === 'Bearer local-test-only');
  assert.match(mock.requests[0].headers['user-agent'], /deepseek-harness\//, 'wire request must retain DSH attribution');
  assert.ok(first.message.content.some((block) => block.type === 'text' && block.text.includes('https://example.com/docs')));
  assert.ok(first.message.source.replayState.response.nativeSearch);
  assert.equal(first.message.source.replayState.blocks.length, first.message.content.length);
  assert.ok(!first.message.content.some((block) => block.type === 'tool-call'));
  await run(adapter, [user('Search a test source.'), first.message, user('Summarize the source without searching again.')]);
  const replayed = mock.requests[1].body.input;
  assert.ok(replayed.some((item) => item.type === 'web_search_call' && item.id === 'ws_test'));
  const replayedAnswer = replayed.find((item) => item.id === 'msg_test');
  assert.ok(replayedAnswer?.content?.[0]?.annotations?.some((item) => item.url === 'https://example.com/docs'));
});

test('ordinary function calls remain executable DSH calls, native searches do not', async (t) => {
  const functionItem = { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'read_local', arguments: '{"path":"test"}', status: 'completed' };
  const mock = await serverFor(t, [responseEvents([searchItem, functionItem])]);
  const { adapter } = createAdapter(ctx, config(mock.baseURL));
  const result = await run(adapter, [user('Search and inspect a local file.')], { tools: [{ name: 'read_local', description: 'Read local', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] });
  assert.equal(result.assembler.finish.kind, 'tool-calls');
  assert.equal(result.message.content.filter((item) => item.type === 'tool-call').length, 1);
  assert.equal(result.message.content.find((item) => item.type === 'tool-call').name, 'read_local');
});

test('auxiliary calls have no search permission and unexpected native images fail loudly', async (t) => {
  const image = { type: 'image_generation_call', id: 'ig_bad', status: 'completed', result: 'never-persist-this-base64' };
  const plainAnswer = { ...answerItem, content: [{ type: 'output_text', text: 'Short title', annotations: [] }] };
  const mock = await serverFor(t, [responseEvents([plainAnswer]), responseEvents([image, answerItem])]);
  const { adapter } = createAdapter(ctx, config(mock.baseURL));
  await run(adapter, [user('Make a short title.')], { purpose: 'session-title' });
  assert.ok(!mock.requests[0].body.tools?.some((item) => item.type === 'web_search'));
  assert.equal(mock.requests[0].body.tool_choice, 'none');
  let result, thrown;
  try { result = await run(adapter, [user('Plain text request.')]); } catch (error) { thrown = error; }
  assert.ok(thrown || result.assembler.finish.kind === 'error');
  assert.ok(!JSON.stringify(result?.message ?? {}).includes('never-persist-this-base64'));
});
