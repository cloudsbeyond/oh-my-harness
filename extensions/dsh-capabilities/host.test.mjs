import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { createNativeTools } from './tools.mjs';
import { createHostBackend } from './backend.mjs';
import { hostFixture } from '../../test/dsh-host-fixture.mjs';
import { apply, Config } from './index.mjs';
import { HarnessError } from '@deepseek-ai/dsh-llm';

function fixture(t) {
  const host = hostFixture(); t.after(() => host.backend.dispose());
  const tools = new Map(createNativeTools({ ctx: host.ctx, backend: host.backend, defineTool }).map((tool) => [tool.name, tool]));
  return { ...host, tools };
}

test('Host entry registers native consumers, a single web provider and lifecycle-owned service', async (t) => {
  const f = hostFixture(); t.after(() => f.backend.dispose());
  const tools = new Map(); const effects = []; const web = []; const services = new Map(); const order = [];
  Object.assign(f.ctx, {
    tools: { register: (definition, options) => { tools.set(definition.name, { definition, options }); order.push('tool'); } },
    web: { registerSearchProvider: (provider) => { web.push(provider); order.push('web'); } },
    effect: (setup) => { const dispose = setup(); effects.push(dispose); },
    provide: (name, value) => { services.set(name, value); order.push('provide'); },
  });
  apply(f.ctx, Config({}));
  assert.equal(tools.size, 9); assert.equal(web.length, 1); assert.equal(web[0].id, 'oh-my-harness');
  assert.equal(web[0].available(), false); assert.equal(order.at(-1), 'provide');
  const backend = services.get('omhCapabilities');
  await assert.rejects(tools.get('native_document_inspect').definition.execute({ file: '/private/secret.csv', question: 'Read it' }, f.exec), (error) => error instanceof HarnessError && error.code === 'INPUT_FILE_FORBIDDEN');
  for (const dispose of effects.reverse()) await dispose();
  await assert.rejects(backend.execute('document.inspect', { question: 'Read', file: { name: 'x.csv', data: Buffer.from('a,b'), mimeType: 'text/csv' } }), (error) => error.code === 'SERVICE_UNAVAILABLE');
});

test('Host Config and independent operation settings agree on shape', () => {
  const parsed = Config({ providers: { sample: { protocol: 'responses', baseURL: 'https://provider.example.com/v1', credential: 'PROVIDER_KEY', models: ['sample'], operations: ['document.inspect'] } }, defaults: { 'document.inspect': { provider: 'sample' } } });
  const ctx = { credentials: { resolve: async () => undefined } };
  const backend = createHostBackend(ctx, parsed);
  assert.equal(backend.hasOperation('document.inspect'), true);
  return backend.dispose();
});

test('actual App defineTool accepts all native schemas and validates canonical media outputs', async (t) => {
  const f = fixture(t);
  assert.equal(f.tools.size, 9);
  for (const [name, args] of [
    ['native_document_inspect', { file: 'values.csv', question: 'Read it' }],
    ['native_image_generate', { prompt: 'A square' }],
    ['native_speech_synthesize', { text: 'A short fixture' }],
    ['capability_providers', {}],
  ]) {
    const tool = f.tools.get(name);
    const value = await tool.execute(args, f.exec);
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, ''), [], name);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(value)));
    const content = tool.output.render(args, value);
    assert.ok(content.every((part) => ['text', 'image', 'file'].includes(part.type)));
  }
});

test('actual host argument validation and strict native checks cannot be bypassed', async (t) => {
  const f = fixture(t); const tool = f.tools.get('native_document_inspect');
  await assert.rejects(tool.execute({ file: 7, question: 'Read it' }, f.exec));
  await assert.rejects(tool.execute({ file: 'values.csv', question: 'Read it', unexpected: 'ignored?' }, f.exec), (error) => error.code === 'INPUT_INVALID');
  assert.equal(f.calls.length, 0); assert.deepEqual(f.reads, []);
});

test('actual host definition and direct HTTP transport complete without an MCP hop', async (t) => {
  const f = hostFixture(); let received;
  t.after(() => f.backend.dispose());
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    received = { path: req.url, auth: req.headers.authorization, body: JSON.parse(raw) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Real local HTTP analysis' }] }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const backend = createHostBackend(f.ctx, { providers: { local: { protocol: 'responses', baseURL: `http://127.0.0.1:${server.address().port}/v1`, credential: 'TEST_KEY', models: ['fixture'], operations: ['document.inspect'] } } });
  t.after(() => backend.dispose());
  const tool = createNativeTools({ ctx: f.ctx, backend, defineTool }).find((item) => item.name === 'native_document_inspect');
  const result = await tool.execute({ file: 'values.csv', question: 'Read the value' }, f.exec);
  assert.equal(result.text, 'Real local HTTP analysis'); assert.equal(received.path, '/v1/responses');
  assert.equal(received.auth, 'Bearer test-native-provider-key');
  assert.equal(received.body.input[0].content[0].type, 'input_file');
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result, ''), []);
});
