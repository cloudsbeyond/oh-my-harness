import { Config as PiConfig, PiAiAdapter, resolveProfiles, credentialStoreFrom, authContextFrom } from './vendor/dsh-pi-adapter.mjs';
import { LlmError, assertUsableApiKey, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import { prepareNativeSearch } from './native-search.mjs';
import { prepareNativeImages } from './native-images.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const name = 'local-codex-native-search';
export const inject = ['llm', 'credentials'];

function boundedInteger(value, fallback, min, max, key) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < min || selected > max) throw new Error(`${key} must be an integer from ${min} to ${max}`);
  return selected;
}

/** Explicit configuration validation; unknown fields fail instead of looking active. */
export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Native Codex configuration must be an object');
  for (const key of Object.keys(raw)) if (!['providers', 'nativeSearch'].includes(key)) throw new Error(`Unknown native Codex configuration field: ${key}`);
  const native = raw.nativeSearch ?? {};
  if (!native || typeof native !== 'object' || Array.isArray(native)) throw new Error('nativeSearch must be an object');
  for (const key of Object.keys(native)) if (!['enabled', 'allowAuxiliary', 'maxSources', 'maxMetadataBytes', 'images'].includes(key)) throw new Error(`Unknown nativeSearch field: ${key}`);
  for (const key of ['enabled', 'allowAuxiliary', 'images']) if (native[key] !== undefined && typeof native[key] !== 'boolean') throw new Error(`nativeSearch.${key} must be boolean`);
  const parsed = PiConfig({ providers: structuredClone(raw.providers ?? {}) });
  const profiles = resolveProfiles(parsed.providers.get(), 'strict');
  if (profiles.size === 0) throw new Error('At least one explicit native Codex provider is required');
  for (const [route, profile] of profiles) {
    if (profile.api !== 'openai-responses') throw new Error(`Native Codex route ${route} requires api: openai-responses`);
    const url = new URL(profile.baseURL);
    const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    const https = url.protocol === 'https:';
    if ((!local && !https) || url.username || url.password || url.search || url.hash) throw new Error(`Native Codex route ${route} must use an HTTPS gateway or local HTTP proxy URL`);
    if (url.pathname.replace(/\/$/, '') !== '/v1') throw new Error(`Native Codex route ${route} must use the proxy /v1 base`);
    if (!profile.apiKeyEnv) throw new Error(`Native Codex route ${route} requires a credential reference`);
  }
  return {
    profiles,
    policy: Object.freeze({
      enabled: native.enabled ?? false,
      allowAuxiliary: native.allowAuxiliary ?? false,
      images: native.images ?? true,
      maxSources: boundedInteger(native.maxSources, 12, 1, 32, 'nativeSearch.maxSources'),
      maxMetadataBytes: boundedInteger(native.maxMetadataBytes, 262144, 4096, 1048576, 'nativeSearch.maxMetadataBytes'),
    }),
  };
}

export function createAdapter(ctx, raw, onDispatch) {
  const { profiles, policy } = validateConfig(raw);
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async (provider, profile) => {
      const hit = await ctx.get('credentials')?.resolve(profile.apiKeyEnv);
      if (!hit?.value) throw new LlmError(`Native Codex route ${provider} has no usable credential for its configured reference`, 'MISSING_CREDENTIAL');
      return assertUsableApiKey(hit.value, 'local-codex-native-search', profile.apiKeyEnv);
    },
    auth: { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
    onReplayDegrade: ({ provider, model }) => ctx.logger?.warn(`native-search: replay projected to text for ${provider}/${model}`),
    prepareStream: (options) => {
      onDispatch?.({ provider: options.provider, model: options.model, purpose: options.purpose ?? 'main', dispatchedAt: new Date().toISOString() });
      const images = prepareNativeImages(options, ctx.get('attachments'), policy.images);
      const search = prepareNativeSearch(options, policy, images);
      return { ...search, wrapStream: (stream) => images.wrap(search.wrapStream(stream)) };
    },
  });
  return { adapter, profiles, policy, routes: [...profiles.keys()] };
}

export async function apply(ctx, raw) {
  // This owner-only status contains identities/times, never user content.
  const file = new URL('runtime-status.json', import.meta.url);
  const generation = randomUUID();
  let status;
  let queue = Promise.resolve();
  const saveStatus = () => {
    queue = queue.catch(() => {}).then(async () => {
      try { await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await writeFile(file, JSON.stringify(status, null, 2) + '\n', { mode: 0o600 });
    });
    return queue;
  };
  const { adapter, profiles, policy, routes } = createAdapter(ctx, raw, (dispatch) => {
    if (ctx.fiber && status?.active) {
      status.lastDispatch = dispatch;
      void saveStatus().catch(() => ctx.logger.warn('native-search: could not update local dispatch status'));
    }
  });
  ctx.llm.registerAdapter(routes, adapter);
  ctx.logger.info(`native-search: registered ${[...profiles.keys()].join(', ')}; search=${policy.enabled}; auxiliary=${policy.allowAuxiliary}; native images=${policy.images}`);
  if (ctx.fiber) {
    status = { generation, pid: process.pid, active: true, activatedAt: new Date().toISOString(), routes: [...profiles.keys()], policy, nativeImages: policy.images };
    await saveStatus();
    ctx.effect(() => async () => {
      await queue.catch(() => {});
      const current = JSON.parse(await readFile(file, 'utf8'));
      if (current.generation === generation) {
        status.active = false;
        status.disposedAt = new Date().toISOString();
        await saveStatus();
      }
    });
  }
}
