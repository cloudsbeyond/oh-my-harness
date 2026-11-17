import { CapabilityError, limits, operationCapabilities, parseInput, parseResult } from './contracts.mjs';
export { CapabilityError } from './contracts.mjs';

const identifier = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(value);
const validModel = (value) => typeof value === 'string' && value.length > 0 && value.length <= 120;
const validTimeout = (value) => Number.isSafeInteger(value) && value > 0 && value <= limits.timeoutMs;
const fail = (code, message) => { throw new CapabilityError(message, code); };
const knownOperation = (value) => typeof value === 'string' && Object.hasOwn(operationCapabilities, value);

/** Small in-process capability registry. No SDK, host, network or persistence dependencies. */
export class CapabilityRuntime {
  #providers = new Map();
  #defaults;
  #timeoutMs;

  constructor({ defaults = {}, timeoutMs = limits.timeoutMs } = {}) {
    if (!validTimeout(timeoutMs) || !defaults || typeof defaults !== 'object' || Array.isArray(defaults)) fail('CONFIG_INVALID', 'Invalid capability runtime configuration');
    this.#timeoutMs = timeoutMs;
    this.#defaults = new Map();
    for (const [operation, binding] of Object.entries(defaults)) {
      if (!knownOperation(operation) || !binding || typeof binding !== 'object' || !identifier(binding.provider) ||
          Object.keys(binding).some((key) => !['provider', 'model'].includes(key)) || (binding.model !== undefined && !validModel(binding.model))) {
        fail('CONFIG_INVALID', 'Invalid capability default binding');
      }
      this.#defaults.set(operation, Object.freeze({ ...binding }));
    }
  }

  /** Unregistering prevents new work; it deliberately does not abort work already dispatched. */
  register(provider) {
    if (!provider || !identifier(provider.id) || !Array.isArray(provider.operations) || !provider.operations.length ||
        provider.operations.some((operation) => !knownOperation(operation)) || new Set(provider.operations).size !== provider.operations.length ||
        typeof provider.execute !== 'function' || (provider.available !== undefined && typeof provider.available !== 'function') ||
        (provider.models !== undefined && (!Array.isArray(provider.models) || !provider.models.length || provider.models.some((model) => !validModel(model)) || new Set(provider.models).size !== provider.models.length))) {
      fail('CONFIG_INVALID', 'Invalid capability provider registration');
    }
    if (this.#providers.has(provider.id)) fail('PROVIDER_DUPLICATE', 'Capability provider id is already registered');
    const entry = Object.freeze({
      id: provider.id, operations: Object.freeze([...provider.operations]), models: Object.freeze([...(provider.models ?? [])]),
      execute: provider.execute.bind(provider), available: provider.available?.bind(provider),
    });
    this.#providers.set(entry.id, entry);
    return () => { if (this.#providers.get(entry.id) === entry) this.#providers.delete(entry.id); };
  }

  #available(entry) {
    try { return entry.available === undefined || entry.available() === true; } catch { return false; }
  }

  list() {
    return [...this.#providers.values()].map((entry) => ({ id: entry.id, operations: [...entry.operations], models: [...entry.models], available: this.#available(entry) }));
  }

  #select(operation, options) {
    let id = options.provider;
    let model = options.model;
    if (id === undefined && model !== undefined) {
      const owners = [...this.#providers.values()].filter((entry) => entry.operations.includes(operation) && entry.models.includes(model));
      if (!owners.length) fail('MODEL_NOT_FOUND', 'No capability provider declares the requested model for this operation');
      if (owners.length !== 1) fail('MODEL_AMBIGUOUS', 'Model belongs to multiple capability providers; specify a provider');
      id = owners[0].id;
    }
    if (id === undefined) {
      const binding = this.#defaults.get(operation);
      if (binding) ({ provider: id, model } = binding);
    }
    let selected;
    if (id !== undefined) {
      selected = this.#providers.get(id);
      if (!selected) fail('PROVIDER_NOT_FOUND', 'Selected capability provider is not registered');
      if (!selected.operations.includes(operation)) fail('PROVIDER_UNSUPPORTED', 'Selected provider does not support this operation');
    } else {
      const candidates = [...this.#providers.values()].filter((entry) => entry.operations.includes(operation) && this.#available(entry));
      if (!candidates.length) fail('PROVIDER_UNAVAILABLE', 'No usable capability provider supports this operation');
      if (candidates.length !== 1) fail('PROVIDER_AMBIGUOUS', 'Multiple capability providers are usable; configure a default or select a provider');
      [selected] = candidates;
    }
    if (model !== undefined && !selected.models.includes(model)) fail('MODEL_NOT_FOUND', 'Selected provider does not declare the requested model');
    if (!this.#available(selected)) fail('PROVIDER_UNAVAILABLE', 'Selected capability provider is unavailable');
    return { selected, model };
  }

  async execute(operation, input, options = {}) {
    if (!knownOperation(operation)) fail('OPERATION_UNKNOWN', 'Unknown capability operation');
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        Object.keys(options).some((key) => !['provider', 'model', 'signal', 'timeoutMs', 'awaitProviderOnCancel'].includes(key)) ||
        (options.awaitProviderOnCancel !== undefined && typeof options.awaitProviderOnCancel !== 'boolean') ||
        (options.provider !== undefined && !identifier(options.provider)) || (options.model !== undefined && !validModel(options.model)) ||
        (options.signal !== undefined && !(options.signal instanceof AbortSignal)) || (options.timeoutMs !== undefined && !validTimeout(options.timeoutMs))) {
      fail('INPUT_INVALID', 'Invalid capability execution options');
    }
    if (options.signal?.aborted) fail('CANCELLED', 'Capability request was cancelled');
    const parsed = parseInput(operation, input);
    const { selected, model } = this.#select(operation, options);
    const timeoutMs = Math.min(options.timeoutMs ?? this.#timeoutMs, this.#timeoutMs);
    const controller = new AbortController();
    const deadline = Date.now() + timeoutMs;
    let timedOut = false;
    const cancelError = () => new CapabilityError(timedOut ? 'Capability request timed out' : 'Capability request was cancelled', timedOut ? 'TIMEOUT' : 'CANCELLED');
    const abort = () => controller.abort();
    let onAbort;
    const stopped = new Promise((_, reject) => {
      onAbort = () => reject(cancelError());
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
    const assertActive = () => {
      // Synchronous parsers and result validation can finish in a microtask before
      // an overdue timer gets its event-loop turn. Never accept their late result.
      if (!controller.signal.aborted && Date.now() >= deadline) { timedOut = true; abort(); }
      if (controller.signal.aborted) throw cancelError();
    };
    let work;
    try {
      if (options.signal?.aborted) abort();
      work = Promise.resolve().then(() => {
        assertActive();
        return selected.execute(operation, parsed, { model, signal: controller.signal, deadline, remainingMs: Math.max(0, deadline - Date.now()) });
      });
      const raw = await Promise.race([work, stopped]);
      assertActive();
      const result = parseResult(operation, raw);
      assertActive();
      return { ...result, ...(result.model === undefined && model !== undefined ? { model } : {}), provider: selected.id, operation };
    } catch (error) {
      try { assertActive(); } catch (stopped) {
        // Native host tools may require quiescent cancellation. Drivers opting
        // into this mode must honor the signal and settle after owned cleanup.
        if (options.awaitProviderOnCancel && work) await work.catch(() => {});
        throw stopped;
      }
      if (error instanceof CapabilityError) throw error;
      // Do not put raw provider errors (which can contain tokens or input) into host tools.
      throw new CapabilityError('Capability provider execution failed', 'PROVIDER_FAILED');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }
}
