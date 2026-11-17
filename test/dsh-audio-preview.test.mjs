import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseFileAddress, validateWavPrefix, readWavPreview, previewMaxBytes, previewWindowBytes } from '../extensions/dsh-capabilities/audio-preview-core.mjs';
import { build } from '../extensions/dsh-capabilities/build-client.mjs';

function wavBytes(frames = 2400) {
  const data = Buffer.alloc(44 + frames * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24); data.writeUInt32LE(48000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(frames * 2, 40);
  return data;
}
const ok = (value) => ({ ok: true, value });
const address = (session = 's-1', path = 'a/speech.wav') =>
  `dsh-resource://file/session/${encodeURIComponent(session)}/${path.split('/').map(encodeURIComponent).join('/')}`;
const metadata = (bytes, version = 'v1') => ({ absolutePath: '/workspace/a/speech.wav', version, bytes: bytes.length });
function remote(bytes, overrides = {}) {
  const calls = [], stats = [];
  return {
    calls, stats,
    readBytes: async (sessionId, path, options, signal) => {
      assert.equal(sessionId, 's-1'); assert.equal(path, 'a/speech.wav');
      assert.deepEqual(Object.keys(options), ['range']);
      assert.deepEqual(Object.keys(options.range).sort(), ['length', 'offset']);
      assert.ok(signal === undefined || signal instanceof AbortSignal);
      const { offset, length } = options.range;
      assert.ok(Number.isSafeInteger(offset) && offset >= 0);
      assert.ok(Number.isSafeInteger(length) && length > 0 && length <= 2 * 1024 * 1024);
      calls.push({ offset, length, signal });
      const data = new Uint8Array(bytes.subarray(offset, offset + length));
      return ok({ ...metadata(bytes), offset, data, eof: offset + data.length >= bytes.length });
    },
    readStat: async (sessionId, path, signal) => {
      assert.equal(sessionId, 's-1'); assert.equal(path, 'a/speech.wav');
      stats.push(signal); return ok(metadata(bytes));
    },
    ...overrides,
  };
}

test('file addresses retain session authority and round-trip POSIX, Windows and UNC paths', () => {
  assert.deepEqual(parseFileAddress(address('s 1', 'a b/c.wav')), { scope: 'session', sessionId: 's 1', path: 'a b/c.wav' });
  for (const path of ['/tmp/a.wav', 'C:/音频/a.wav', '//server/share/a.wav', '../a.wav']) {
    assert.equal(parseFileAddress(address('s-1', path)).path, path);
  }
  assert.deepEqual(parseFileAddress('dsh-resource://file/absolute/home/u/a.wav'), { scope: 'absolute', path: '/home/u/a.wav' });
  assert.deepEqual(parseFileAddress('dsh-resource://file/absolute/C:/x/a.wav'), { scope: 'absolute', path: 'C:/x/a.wav' });
  assert.deepEqual(parseFileAddress('dsh-resource://file/absolute//server/share/a.wav'), { scope: 'absolute', path: '//server/share/a.wav' });
  for (const invalid of [null, 'dsh-resource://file/absolute/', 'dsh-resource://file/session//x.wav', 'dsh-resource://file/other/s/x', 'dsh-resource://file/session/s', 'not-a-resource', 'dsh-resource://file/session/s/%E0%A4%A']) {
    assert.equal(parseFileAddress(invalid), undefined);
  }
  assert.equal(parseFileAddress(address('s-1', 'a#b?.wav') + '?ignored#fragment').path, 'a#b?.wav');
});

test('WAV validation requires complete RIFF and format/data chunks, not a playable prefix', () => {
  assert.doesNotThrow(() => validateWavPrefix(wavBytes()));
  for (const bytes of [Buffer.alloc(10), Buffer.from('OggS....' + 'x'.repeat(40)), wavBytes().subarray(0, 44), (() => { const b = wavBytes(); b.write('AVI ', 8); return b; })(), (() => { const b = wavBytes(); b.writeUInt32LE(b.length, 40); return b; })(), (() => { const b = wavBytes(); b.write('JUNK', 36); return b; })()]) {
    assert.throws(() => validateWavPrefix(bytes), /RIFF\/WAVE|WAV|chunk|complete/);
  }
});

test('bounded windows assemble all bytes with exactly one range wrapper and a final stat', async () => {
  const bytes = wavBytes(48000); const io = remote(bytes);
  const result = await readWavPreview({ ...io, resourceAddress: address(), window: 32000 });
  assert.equal(result.version, 'v1'); assert.deepEqual(result.data, new Uint8Array(bytes));
  assert.deepEqual(io.calls.map((c) => c.offset), [0, 32000, 64000, 96000]);
  assert.equal(io.stats.length, 1);
});

test('read errors, offset gaps, changed versions and changed final metadata never publish partial bytes', async () => {
  const bytes = wavBytes(48000);
  await assert.rejects(readWavPreview({ ...remote(bytes), resourceAddress: address(), readBytes: async () => ({ ok: false, error: new Error('denied') }) }), /denied/);
  for (const patch of [{ version: 'v2' }, { offset: 1005 }, { absolutePath: '/other.wav' }]) {
    const io = remote(bytes); const base = io.readBytes;
    io.readBytes = async (...args) => { const r = await base(...args); return io.calls.length === 2 ? ok({ ...r.value, ...patch }) : r; };
    await assert.rejects(readWavPreview({ ...io, resourceAddress: address(), window: 1000 }), /changed|unexpected offset/);
  }
  for (const patch of [{ version: 'v2' }, { bytes: bytes.length - 2 }, { absolutePath: '/other.wav' }]) {
    await assert.rejects(readWavPreview({ ...remote(bytes), resourceAddress: address(), readStat: async () => ok({ ...metadata(bytes), ...patch }) }), /changed|size|complete/);
  }
  await assert.rejects(readWavPreview({ ...remote(bytes), resourceAddress: address(), readStat: async () => ({ ok: false, error: new Error('gone') }) }), /gone/);
});

test('limits are finite safe integers and constrain every read before allocation', async () => {
  const bytes = wavBytes();
  for (const option of ['maxBytes', 'window']) {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      const io = remote(bytes);
      await assert.rejects(readWavPreview({ ...io, resourceAddress: address(), [option]: value }), /limit|integer|window/);
      assert.equal(io.calls.length, 0);
    }
  }
  const io = remote(bytes);
  await assert.rejects(readWavPreview({ ...io, resourceAddress: address(), maxBytes: 1024 }), /size limit/);
  assert.ok(io.calls.every((c) => c.length <= 1024));
  assert.ok(previewWindowBytes <= 2 * 1024 * 1024);
  assert.ok(previewMaxBytes > 2 * 1024 * 1024 + 44);
});

test('invalid wire data, oversized windows, early EOF and no progress are refused', async () => {
  const bytes = wavBytes();
  for (const patch of [
    { data: 'not-base64' }, { data: new Uint8Array(2001) }, { data: new Uint8Array(0), eof: false },
    { eof: true }, { version: undefined }, { bytes: NaN }, { bytes: bytes.length + 1 },
  ]) {
    const io = remote(bytes); const base = io.readBytes;
    io.readBytes = async (...args) => { const r = await base(...args); return ok({ ...r.value, ...patch }); };
    await assert.rejects(readWavPreview({ ...io, resourceAddress: address(), window: 1000 }), /bytes|window|progress|complete|version|size|EOF/);
  }
});

test('unknown byte size remains bounded and exact size completes without an extra range read', async () => {
  const bytes = wavBytes(); const io = remote(bytes); const base = io.readBytes;
  io.readBytes = async (...args) => { const r = await base(...args); delete r.value.bytes; return r; };
  const result = await readWavPreview({ ...io, resourceAddress: address(), maxBytes: bytes.length, window: 1000 });
  assert.deepEqual(result.data, new Uint8Array(bytes));
  assert.equal(io.calls.length, Math.ceil(bytes.length / 1000));
});

test('cancellation before reads and during the last EOF or final stat prevents publication', async () => {
  const bytes = wavBytes();
  for (const stage of ['before', 'eof', 'stat']) {
    const controller = new AbortController(); const io = remote(bytes);
    if (stage === 'before') controller.abort();
    if (stage === 'eof') { const base = io.readBytes; io.readBytes = async (...args) => { const result = await base(...args); controller.abort(); return result; }; }
    if (stage === 'stat') { const base = io.readStat; io.readStat = async (...args) => { const result = await base(...args); controller.abort(); return result; }; }
    await assert.rejects(readWavPreview({ ...io, resourceAddress: address(), signal: controller.signal }), (e) => e.name === 'AbortError');
    assert.equal(io.calls.length, stage === 'before' ? 0 : 1);
  }
});

test('absolute scope or malformed addresses never borrow a current session', async () => {
  for (const resourceAddress of ['dsh-resource://file/absolute/tmp/a.wav', '/tmp/a.wav', undefined]) {
    await assert.rejects(readWavPreview({ resourceAddress, readBytes: async () => { throw new Error('must not read'); } }), /session-scoped/);
  }
});

// A deterministic hook lifecycle runner, not a browser/visual acceptance test.
function clientHarness(workspaceFiles) {
  const captured = [], slots = [], disposers = [], states = [], refs = [], effects = [];
  let cursor = 0; const created = [], revoked = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], (v) => { states[i] = v; }]; },
    useRef: (initial) => { const i = cursor++; return refs[i] ??= { current: initial }; },
    useCallback: (callback) => { const i = cursor++; return refs[i] ??= callback; },
    useEffect: (setup, deps) => { const i = cursor++; const old = effects[i]; if (!old || deps.some((d, j) => d !== old.deps[j])) effects[i] = { deps, setup, pending: true, cleanup: old?.cleanup }; },
  };
  vm.runInNewContext(readFileSync(new URL('../extensions/dsh-capabilities/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (r) => captured.push(r) } }, AbortController, Uint8Array, Blob,
    URL: { createObjectURL: (blob) => { created.push(blob); return `blob:owned-${created.length}`; }, revokeObjectURL: (url) => revoked.push(url) },
  });
  const plugin = captured[0].factory((id) => { assert.equal(id, 'react'); return react; });
  const definitions = [];
  plugin.apply({
    effect: (setup) => { const dispose = setup(); if (dispose) disposers.push(dispose); },
    documentPreviews: { register: (def) => { definitions.push(def); return () => definitions.pop(); } },
    slots: {
      inject: (name, factory) => { assert.equal(name, 'sidebar.right.tab.document'); const cleanup = factory(); assert.equal(typeof cleanup, 'function'); return cleanup; },
      register: (options, body) => { slots.push({ options, body }); return () => slots.pop(); },
    },
    remote: { workspaceFiles },
  });
  return {
    plugin, definitions, created, revoked,
    render(props) { cursor = 0; return slots[0].body({ ...slots[0].options.inject('slot-session'), ...props }); },
    flush() { for (const e of effects) if (e?.pending) { e.cleanup?.(); e.cleanup = e.setup(); e.pending = false; } },
    unmount() { for (const e of effects) e?.cleanup?.(); },
    dispose() { for (const d of disposers.reverse()) d(); assert.equal(slots.length, 0); assert.equal(definitions.length, 0); },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const content = (revision, loaded = () => {}, failed = () => {}) => ({ kind: 'renderer', revision, loaded, failed, reload() {} });

test('generated artifact owns renderer/slot registration and uses the real readBytes options ABI', async () => {
  assert.equal(readFileSync(new URL('../extensions/dsh-capabilities/client.js', import.meta.url), 'utf8'), build());
  const bytes = wavBytes(); const io = remote(bytes); const loaded = [], failed = [];
  const c = clientHarness({ readBytes: io.readBytes, stat: io.readStat });
  assert.deepEqual(Array.from(c.plugin.inject), ['documentPreviews', 'slots', 'remote.workspaceFiles']);
  const def = c.definitions[0];
  assert.equal(def.id, 'oh-my-harness/audio'); assert.equal(def.title(), 'Audio');
  assert.deepEqual(Array.from(def.extensions), ['wav']); assert.deepEqual(Array.from(def.binaryExtensions), ['wav']);
  assert.equal(def.loading, 'renderer'); assert.equal(def.wrap, false);
  const props = { resourceAddress: address(), content: content(0, (v) => loaded.push(v), () => failed.push(true)) };
  c.render(props); c.flush(); await settle();
  const audio = c.render(props);
  assert.equal(audio.type, 'audio'); assert.deepEqual(loaded, ['v1']); assert.deepEqual(failed, []);
  assert.equal(c.created.length, 1); assert.equal(c.created[0].size, bytes.length);
  const detached = [];
  audio.props.ref({ pause: () => detached.push('pause'), removeAttribute: (name) => detached.push(name), load: () => detached.push('load') });
  // React detaches the element before running the passive effect cleanup.
  audio.props.ref(null);
  assert.deepEqual(detached, ['pause', 'src', 'load']);
  c.unmount(); assert.deepEqual(c.revoked, ['blob:owned-1']); c.dispose();
});

test('replacement hides stale audio before effects run and retires its owned URL', async () => {
  const bytes = wavBytes(); const io = remote(bytes); const c = clientHarness({ readBytes: io.readBytes, stat: io.readStat });
  const props = { resourceAddress: address(), content: content(0) };
  c.render(props); c.flush(); await settle(); assert.equal(c.render(props).type, 'audio');
  const next = { ...props, content: content(1) };
  assert.notEqual(c.render(next).type, 'audio');
  c.flush(); assert.deepEqual(c.revoked, ['blob:owned-1']);
  await settle(); assert.equal(c.render(next).props.src, 'blob:owned-2');
  c.unmount(); assert.deepEqual(c.revoked, ['blob:owned-1', 'blob:owned-2']); c.dispose();
});

test('unmount cancels pending reads without URL creation or stale loaded/failed reports', async () => {
  let finish, signal; const reports = [];
  const c = clientHarness({ readBytes: (...args) => { signal = args[3]; return new Promise((r) => { finish = r; }); }, stat: async () => { throw new Error('must not stat'); } });
  c.render({ resourceAddress: address(), content: content(0, () => reports.push('loaded'), () => reports.push('failed')) }); c.flush();
  c.unmount(); assert.equal(signal.aborted, true);
  const bytes = wavBytes(); finish(ok({ ...metadata(bytes), offset: 0, data: new Uint8Array(bytes), eof: true })); await settle();
  assert.deepEqual(reports, []); assert.equal(c.created.length, 0); c.dispose();
});

test('renderer errors call failed without publishing an audio URL', async () => {
  const reports = []; const c = clientHarness({ readBytes: async () => ({ ok: false, error: new Error('offline') }), stat: async () => { throw new Error('must not stat'); } });
  const props = { resourceAddress: address(), content: content(0, () => reports.push('loaded'), () => reports.push('failed')) };
  c.render(props); c.flush(); await settle();
  assert.equal(c.render(props).props.role, 'alert'); assert.deepEqual(reports, ['failed']); assert.equal(c.created.length, 0);
  c.unmount(); c.dispose();
});
