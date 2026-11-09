#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { withGatewayClient } from '../src/client.mjs';
import {
  createRegistry, defaultConfigPath, endpoint, gatewayEndpoint, gatewayKeyFile, modelKeyFile,
  readConfig, readKey, root, setting, stateDir, upstreamKeyFile,
} from '../src/config.mjs';
import { gatewayServer } from '../src/http.mjs';

const dshVersion = '0.2.1-rc.5';
const stateConfig = path.join(stateDir, 'config.json');
const proxyConfig = path.resolve(process.env.CLIPROXY_CONFIG ?? path.join(stateDir, 'cliproxyapi.yaml'));
const workspace = path.resolve(setting('WORKSPACE') ?? path.join(stateDir, 'workspace'));
const dshHome = path.join(stateDir, 'dsh');
const command = process.argv[2];
const args = process.argv.slice(3);

function privateDirectory(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function createFile(file, data) {
  try {
    writeFileSync(file, data, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

function replaceFile(file, data) {
  const temp = file + '.' + randomUUID();
  try {
    writeFileSync(temp, data, { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function json(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function initKey(file, override) {
  if (!override) createFile(file, randomBytes(32).toString('hex') + '\n');
  return readKey(file);
}

function initProxyConfig(upstream, gatewayKey, modelKey) {
  const upstreamKey = readKey(upstreamKeyFile());
  if (upstreamKey === gatewayKey) throw new Error('Use a separate CLIProxyAPI client key');
  if (existsSync(proxyConfig)) {
    let existing;
    try {
      existing = JSON.parse(readFileSync(proxyConfig, 'utf8'));
    } catch {
      throw new Error('Set CLIPROXY_CONFIG and the client key files for an existing YAML configuration');
    }
    const keys = existing?.access?.['api-keys'];
    if (!Array.isArray(keys)) throw new Error('Set CLIPROXY_CONFIG for a custom CLIProxyAPI configuration');
    if (keys.includes(gatewayKey)) {
      // Migrate the previous shared key while retaining other configured keys and OAuth state.
      existing.access['api-keys'] = [...new Set([...keys.filter((key) => key !== gatewayKey), modelKey, upstreamKey])];
      replaceFile(proxyConfig, json(existing));
    } else if (!keys.includes(modelKey) || !keys.includes(upstreamKey)) {
      throw new Error('Configure the model and upstream client keys in CLIProxyAPI access.api-keys');
    }
    return;
  }
  const authDir = path.join(stateDir, 'cliproxy-auth');
  privateDirectory(authDir);
  createFile(proxyConfig, json({
    'config-version': 8,
    server: { host: '127.0.0.1', port: Number(upstream.port), 'max-request-body-bytes': 8388608 },
    access: { 'api-keys': [...new Set([modelKey, upstreamKey])] },
    oauth: { 'auth-dir': authDir },
    management: { 'allow-remote': false, 'disable-control-panel': true },
    observability: { logs: { 'request-log': false } },
  }));
}

function init() {
  const { values } = parseArgs({ args, options: { provider: { type: 'string', default: 'both' } } });
  if (!['both', 'codex', 'kimi'].includes(values.provider)) throw new Error('Use --provider both, codex, or kimi');
  if (values.provider !== 'both' && setting('CONFIG')) {
    throw new Error('Choose providers in OH_MY_HARNESS_CONFIG when using a custom config');
  }
  privateDirectory(stateDir);
  if (!setting('CONFIG') && !existsSync(stateConfig)) {
    const template = JSON.parse(readFileSync(defaultConfigPath, 'utf8'));
    if (values.provider !== 'both') {
      const picked = template.providers[values.provider];
      template.providers = { [values.provider]: picked };
      template.defaults = Object.fromEntries(picked.capabilities.map((capability) => [capability, values.provider]));
    }
    createFile(stateConfig, json(template));
  }
  const config = readConfig();
  if (values.provider !== 'both' &&
      (Object.keys(config.providers).length !== 1 || !Object.hasOwn(config.providers, values.provider))) {
    throw new Error('This state directory uses a different provider configuration');
  }
  const gatewayKey = initKey(gatewayKeyFile(), setting('KEY_FILE'));
  const upstream = endpoint(config.upstream, 'api');
  if (!process.env.CLIPROXY_CONFIG && upstream.protocol === 'http:' && upstream.hostname === '127.0.0.1' && upstream.port) {
    const modelKey = initKey(modelKeyFile(), setting('MODEL_KEY_FILE'));
    if (gatewayKey === modelKey) throw new Error('Use separate capability and model keys');
    initProxyConfig(upstream, gatewayKey, modelKey);
  }
  privateDirectory(workspace);
  console.log('State initialized at ' + stateDir);
}

function configuredModelBase(config) {
  return endpoint(setting('MODEL_URL') ?? config.upstream, 'api');
}

function run(executable, args, options = {}) {
  const child = spawn(executable, args, { stdio: 'inherit', ...options });
  const forward = (signal) => child.kill(signal);
  const signals = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) process.once(signal, forward);
  child.on('error', (error) => {
    console.error(executable + ': ' + error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    for (const name of signals) process.removeListener(name, forward);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

function renderDSH(config, modelBase, mcpURL) {
  const registry = createRegistry(config);
  const apiNames = { responses: 'openai-responses', chat: 'openai-completions', messages: 'anthropic-messages' };
  const apiKeyEnv = 'OH_MY_HARNESS_MODEL_API_KEY';
  const providers = Object.fromEntries(registry.list().filter((item) => item.capabilities.includes('text')).map((item) => [
    item.id,
    {
      displayName: item.name, api: apiNames[item.protocol], apiKeyEnv,
      baseURL: item.protocol === 'messages' ? modelBase.origin : modelBase.href.replace(/\/$/, ''),
      timeoutMs: 180_000, streamIdleTimeoutMs: 180_000, retryPolicy: { mode: 'normal', maxRetries: 0 },
      ...(item.protocol !== 'messages' ? { transport: 'sse' } : {}),
      ...(item.protocol === 'chat' ? { compat: { supportsStore: false, maxTokensField: 'max_tokens', supportsDeveloperRole: false } } : {}),
      ...(item.reasoningEffort ? { reasoning: item.reasoningEffort } : {}),
      models: item.models.map((entry) => ({ ...entry, name: entry.name ?? entry.id,
        ...(item.reasoningEffort ? { reasoningEfforts: { [item.reasoningEffort]: item.reasoningEffort } } : {}),
        input: item.capabilities.includes('vision') ? ['text', 'image'] : ['text'] })),
    },
  ]));
  const chosen = registry.select('text');
  const profileDir = path.join(dshHome, 'profiles', 'web');
  privateDirectory(profileDir);
  privateDirectory(workspace);
  replaceFile(path.join(profileDir, 'cordis.patch.yml'), json([
    { id: 'llm-pi-ai', config: { providers } },
    { id: 'credentials', disabled: false },
    { id: 'agent-default-model', config: {
      provider: chosen.id, model: chosen.model, ...(chosen.reasoningEffort ? { reasoningEffort: chosen.reasoningEffort } : {}),
    } },
    { insert: [{ id: 'mcp-oh-my-harness', name: '@deepseek-ai/dsh-mcp-client', config: {
      serverName: 'gateway', transport: 'stdio', command: process.execPath,
      args: [path.join(root, 'src', 'stdio.mjs')],
      env: {
        OH_MY_HARNESS_MCP_URL: mcpURL.href, OH_MY_HARNESS_KEY_FILE: gatewayKeyFile(),
        OH_MY_HARNESS_ARTIFACT_DIR: path.join(workspace, 'gateway-tools'),
      },
      toolCallTimeoutMs: 185_000,
    } }] },
  ]));
}

async function doctorModels(config, base, key) {
  const response = await fetch(new URL('models', base), {
    headers: { Authorization: 'Bearer ' + key }, redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Model API /v1/models returned HTTP ' + response.status);
  const { data } = await response.json();
  if (!Array.isArray(data) || data.some((model) => typeof model?.id !== 'string' || !model.id)) {
    throw new Error('Model API /v1/models returned an invalid model list');
  }
  const advertised = new Set(data.map((model) => model.id));
  const missing = createRegistry(config).list().filter((item) => item.capabilities.includes('text'))
    .flatMap((item) => item.models.filter(({ id }) => !advertised.has(id)).map(({ id }) => item.id + '/' + id));
  console.log(json({ modelAPI: base.href, models: [...advertised].sort(), missing }));
  if (missing.length) process.exitCode = 1;
}

async function doctorCapabilities(url, key) {
  const { tools } = await withGatewayClient(url, key, (client, signal) => client.listTools(undefined, { signal }));
  if (!tools.some(({ name }) => name === 'list_providers')) throw new Error('Capability Proxy MCP did not advertise list_providers');
  console.log(json({ capabilityProxy: url.href, tools: tools.map(({ name }) => name) }));
}

async function main() {
  if (command === 'init') return init();
  if (command === 'proxy') {
    if (!existsSync(proxyConfig)) throw new Error('Run init or point CLIPROXY_CONFIG at an existing CLIProxyAPI config');
    return run(process.env.CLIPROXY_BIN ?? 'cli-proxy-api', ['-config', proxyConfig, ...args]);
  }
  if (!['start', 'doctor', 'dsh'].includes(command)) throw new Error('Choose init, proxy, start, doctor, or dsh');
  const config = readConfig();
  if (command === 'start') {
    const server = gatewayServer(config, readKey(), readKey(upstreamKeyFile()));
    server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
    return server.listen(config.listen.port, '127.0.0.1', () => {
      console.log(`Capability Proxy listening at http://127.0.0.1:${config.listen.port}/mcp`);
    });
  }
  if (command === 'doctor') {
    const { values } = parseArgs({ args, options: { models: { type: 'boolean' } } });
    if (values.models) return doctorModels(config, configuredModelBase(config), readKey(modelKeyFile()));
    return doctorCapabilities(gatewayEndpoint(`http://127.0.0.1:${config.listen.port}/mcp`), readKey());
  }
  const modelBase = configuredModelBase(config);
  const mcpURL = gatewayEndpoint(`http://127.0.0.1:${config.listen.port}/mcp`);
  const modelKey = readKey(modelKeyFile());
  readKey();
  renderDSH(config, modelBase, mcpURL);
  const env = { ...process.env, DSH_HOME: dshHome, OH_MY_HARNESS_MODEL_API_KEY: modelKey };
  const options = { cwd: workspace, env };
  const executable = setting('DSH_BIN');
  return executable ? run(executable, ['web', ...args], options) :
    run('npm', ['exec', '--yes', '--package', '@deepseek-ai/dsh@' + dshVersion, '--', 'dsh', 'web', ...args], options);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
