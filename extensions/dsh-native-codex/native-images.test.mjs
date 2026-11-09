import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareNativeImages } from './native-images.mjs';
import { prepareNativeSearch } from './native-search.mjs';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const result = { id: 'ig_test', status: 'completed', output_format: 'png', result: png.toString('base64') };
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const ref = { attachmentId: 'sha256:' + 'a'.repeat(64), bytes: png.length, mediaType: 'image/png' };
const model = { id: 'test', api: 'openai-responses', provider: 'codex' };
const options = { provider: 'codex', model: 'test', messages: [user('Generate an image of a blue circle.')] };
const policy = { enabled: true };
const payload = { input: [{ role: 'user', content: 'test' }], instructions: 'Keep the answer brief.', reasoning: { effort: 'max' } };
const finish = { type: 'finish', reason: { kind: 'stop' } };
async function* chunks(...items) { yield* items; }
async function collect(stream) {
  const result = [];
  for await (const chunk of stream) result.push(chunk);
  return result;
}

test('image intent authorizes the Responses tool without inheriting reasoning', async () => {
  const images = prepareNativeImages(options, {}, true);
  const search = prepareNativeSearch(options, policy, images);
  const result = await search.onPayload(payload, model);
  assert.ok(result.tools.some((item) => item.type === 'image_generation'));
  assert.ok(result.tool_choice.tools.some((item) => item.type === 'image_generation'));
  assert.equal(result.reasoning, undefined);
  assert.match(result.instructions, /^Keep the answer brief\.\n\nUse the built-in image_generation tool/);
  assert.equal(payload.reasoning.effort, 'max');

  for (const message of ['Describe this image.', 'Do not generate an image.', 'Generate an image using mcp__gateway__generate_image.']) {
    const request = { ...options, messages: [user(message)] };
    const images = prepareNativeImages(request, {}, true);
    const plain = await prepareNativeSearch(request, policy, images).onPayload(payload, model);
    assert.equal(plain.reasoning.effort, 'max');
    assert.equal(plain.instructions, payload.instructions);
    assert.ok(!plain.tools.some((item) => item.type === 'image_generation'));
  }
  assert.equal(prepareNativeImages({ ...options, purpose: 'session-title' }, {}, true).tool, undefined);
});

test('image routing distinguishes container builds and image content constraints', async () => {
  const requests = [
    ['Create a Docker image for this service.', false],
    ['生成一张图片，不要生成文字。', true],
    ['Generate an image but do not generate text.', true],
    ['Do not generate an image. Describe the layout.', false],
    ['不要生成文字，帮我画一张图片。', true],
  ];
  for (const [text, expected] of requests) {
    const images = prepareNativeImages({ ...options, messages: [user(text)] }, {}, true);
    assert.equal(Boolean(images.tool), expected, text);
    const result = await images.project(structuredClone(payload));
    assert.equal(result.reasoning?.effort, expected ? undefined : 'max', text);
  }
});

test('completed image is stored once with exact original bytes and projected on follow-up', async () => {
  const writes = [];
  const attachments = {
    async saveImage({ data }) { writes.push('preview'); assert.deepEqual(data, png); return ref; },
    async saveFile({ data }) { writes.push('original'); assert.deepEqual(data, png); return { name: 'image.png' }; },
    fileHostPath() { return '/tmp/image.png'; },
    async readImage() { return { ref, data: png }; },
  };
  const images = prepareNativeImages(options, attachments, true);
  images.capture(result);
  images.capture(result);
  const received = await collect(images.wrap(chunks(finish)));
  assert.deepEqual(writes, ['preview', 'original']);
  const stored = received.at(-1).replayState;
  assert.equal(stored.response.nativeImages.image, ref);
  assert.ok(!JSON.stringify(stored).includes(result.result));
  assert.match(received[1].text, /!\[Codex image\]/);
  const assistant = { role: 'assistant', source: { replayState: stored }, content: [] };
  const follow = prepareNativeImages({ ...options, messages: [assistant, user('What color is it?')] }, attachments, true);
  const next = await follow.project(structuredClone(payload));
  assert.equal(next.input[0].content.at(-1).image_url, `data:image/png;base64,${result.result}`);
  assert.equal(next.reasoning.effort, 'max');
});

test('incomplete and failed responses publish no image', async () => {
  const images = prepareNativeImages(options, {}, true);
  assert.throws(() => images.capture({ ...result, status: 'in_progress' }), /invalid/);
  images.capture(result);
  const failed = { type: 'finish', reason: { kind: 'error' } };
  assert.deepEqual(await collect(images.wrap(chunks(failed))), [failed]);
});
