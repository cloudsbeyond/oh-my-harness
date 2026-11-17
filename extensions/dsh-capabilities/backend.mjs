import { CapabilityRuntime, CapabilityError } from '../../src/capabilities/runtime.mjs';
import { operationCapabilities } from '../../src/capabilities/contracts.mjs';
import { createProtocolProvider } from '../../src/capabilities/protocol-provider.mjs';
import { requestUpstream } from '../../src/capabilities/media.mjs';
import { createRealtimeExecutor } from '../../src/capabilities/realtime.mjs';
import { parseNativeConfig } from './config.mjs';

const fail = (message, code) => { throw new CapabilityError(message, code); };
const usableKey = (value) => typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value);

/** Direct Host consumer: credentials and lifecycle stay outside the independent core. */
export function createHostBackend(ctx, raw = {}, { request = requestUpstream, realtimeFactory = createRealtimeExecutor } = {}) {
  const config = parseNativeConfig(raw);
  const runtime = new CapabilityRuntime({ defaults: config.defaults });
  const lifetime = new AbortController();
  const pending = new Set();
  async function credential(profile, signal) {
    signal?.throwIfAborted();
    let hit;
    try { hit = await ctx.credentials.resolve(profile.credential); }
    catch { fail('The selected provider credential cannot be resolved', 'MISSING_CREDENTIAL'); }
    signal?.throwIfAborted();
    if (!usableKey(hit?.value)) fail('The selected provider has no usable configured credential', 'MISSING_CREDENTIAL');
    return hit.value;
  }
  for (const [id, source] of Object.entries(config.providers)) {
    if (!source.enabled) continue;
    const profile = { ...source, id, models: source.models.map((id) => ({ id })), capabilities: [...new Set(source.operations.map((op) => operationCapabilities[op]))] };
    const driver = createProtocolProvider(profile, {
      gateway: async (route, payload, timeoutMs, signal) => request(profile.baseURL, await credential(source, signal), route, payload, timeoutMs, signal),
      realtime: async (operation, input, selected, signal) => {
        const key = await credential(source, signal);
        return realtimeFactory({ upstream: new URL(profile.baseURL), token: key })(operation, input, selected, signal);
      },
    });
    driver.operations = [...source.operations];
    runtime.register(driver);
  }
  function run(signal, body) {
    if (lifetime.signal.aborted) return Promise.reject(new CapabilityError('Native capability service is unavailable', 'SERVICE_UNAVAILABLE'));
    if (signal !== undefined && !(signal instanceof AbortSignal)) return Promise.reject(new CapabilityError('Invalid native execution signal', 'INPUT_INVALID'));
    if (pending.size >= config.maxConcurrentTasks) return Promise.reject(new CapabilityError('Native capability tasks are busy; no extra paid work was queued', 'CAPABILITY_BUSY'));
    const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
    const execute = (operation, input, options = {}) => runtime.execute(operation, input, { ...options, signal: combined, awaitProviderOnCancel: true });
    const task = Promise.resolve().then(() => { combined.throwIfAborted(); return body({ signal: combined, execute }); });
    pending.add(task);
    // Attach both settlement paths immediately; avoid a floating rejected finally-promise.
    task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  }
  function register(provider) {
    if (lifetime.signal.aborted) fail('Native capability service is unavailable', 'SERVICE_UNAVAILABLE');
    return runtime.register(provider);
  }
  async function status() {
    const entries = new Map(runtime.list().map((item) => [item.id, item]));
    const ids = [...new Set([...Object.keys(config.providers), ...entries.keys()])];
    const providers = await Promise.all(ids.map(async (id) => {
      const profile = config.providers[id], entry = entries.get(id);
      let credentialReady;
      if (profile) {
        try { credentialReady = profile.enabled && usableKey((await ctx.credentials.resolve(profile.credential))?.value); }
        catch { credentialReady = false; }
      }
      return { id, name: profile?.name ?? id, enabled: profile?.enabled ?? true, models: entry?.models ?? profile?.models ?? [],
        operations: entry?.operations ?? profile?.operations ?? [], available: !lifetime.signal.aborted && Boolean(entry?.available) && credentialReady !== false,
        ...(credentialReady === undefined ? {} : { credentialReady }) };
    }));
    return { providers, defaults: structuredClone(config.defaults), maxConcurrentTasks: config.maxConcurrentTasks };
  }
  async function ready(operation) {
    if (lifetime.signal.aborted) return false;
    const entries = (await status()).providers.filter((entry) => entry.enabled && entry.operations.includes(operation));
    const binding = config.defaults[operation];
    const selected = binding ? entries.find((entry) => entry.id === binding.provider) : entries.length === 1 ? entries[0] : undefined;
    return Boolean(selected?.available && (!binding?.model || selected.models.includes(binding.model)));
  }
  return {
    run, register, status, ready,
    hasOperation: (operation) => !lifetime.signal.aborted && runtime.list().some((entry) => entry.available && entry.operations.includes(operation)),
    execute: (operation, input, options = {}) => run(options.signal, ({ execute }) => {
      const { signal: _signal, ...selection } = options;
      return execute(operation, input, selection);
    }),
    async dispose() { lifetime.abort(); await Promise.allSettled([...pending]); },
  };
}
