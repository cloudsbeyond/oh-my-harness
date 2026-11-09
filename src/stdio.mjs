import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { gatewayEndpoint, readKey, setting } from './config.mjs';
import { withGatewayClient } from './client.mjs';

const url = gatewayEndpoint('http://127.0.0.1:8318/mcp');
const artifactDir = setting('ARTIFACT_DIR');
if (!artifactDir || !path.isAbsolute(artifactDir)) throw new Error('Provide an absolute OH_MY_HARNESS_ARTIFACT_DIR');
await mkdir(artifactDir, { recursive: true, mode: 0o700 });
const artifacts = await realpath(artifactDir);
const fileLimit = 5 * 1024 * 1024;
const audioLimit = 2 * 1024 * 1024 + 44;

async function readArtifact(file, limit) {
  if (typeof file !== 'string' || !file.trim() || file.length > 1024) throw new Error('Supply a file path');
  const resolved = await realpath(path.resolve(artifacts, file));
  const relative = path.relative(artifacts, resolved);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('The file must be inside ' + artifacts);
  }
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0 || info.size > limit) throw new Error('Supply a nonempty regular file within the tool limit');
    const data = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead !== data.length) throw new Error('Input changed during read');
    return data;
  } finally {
    await handle.close();
  }
}

const fileTools = new Map([
  ['inspect_image', { image_base64: 'file', second_image_base64: 'second_file' }],
  ['edit_image', { image_base64: 'file' }],
  ['inspect_document', { file_base64: 'file' }],
  ['inspect_video', { file_base64: 'file' }],
  ['ask_audio', { audio_base64: 'file' }],
  ['transcribe_audio', { audio_base64: 'file' }],
]);
const outputTypes = new Map([
  ['generate_image', { type: 'image', mime: 'image/png', extension: '.png', limit: 8 * 1024 * 1024 }],
  ['edit_image', { type: 'image', mime: 'image/png', extension: '.png', limit: 8 * 1024 * 1024 }],
  ['synthesize_speech', { type: 'audio', mime: 'audio/wav', extension: '.wav', limit: audioLimit }],
]);

function localTool(tool) {
  const mapping = fileTools.get(tool.name);
  const output = outputTypes.get(tool.name);
  if (!mapping) return output ? { ...tool, description: tool.description + ' Returns a local file path.' } : tool;
  const properties = { ...tool.inputSchema.properties };
  const required = (tool.inputSchema.required ?? []).filter((name) => name !== 'filename').map((name) => mapping[name] ?? name);
  for (const [wire, local] of Object.entries(mapping)) {
    delete properties[wire];
    properties[local] = { type: 'string', minLength: 1, maxLength: 1024, description: 'File inside ' + artifacts };
  }
  delete properties.filename;
  return {
    ...tool, description: tool.description + ' Put input files in ' + artifacts + '.' + (output ? ' Returns a local file path.' : ''),
    inputSchema: { ...tool.inputSchema, properties, required },
  };
}

async function wireArgs(name, args) {
  const mapping = fileTools.get(name);
  if (!mapping) return args;
  const body = { ...args };
  for (const [wire, local] of Object.entries(mapping)) {
    delete body[wire];
    delete body[local];
    if (local === 'second_file' && args[local] === undefined) continue;
    const data = await readArtifact(args[local], wire === 'audio_base64' ? audioLimit : fileLimit);
    body[wire] = data.toString('base64');
    if (wire === 'file_base64') body.filename = path.basename(args[local]);
  }
  return body;
}

function textResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

async function localResult(name, result) {
  const output = outputTypes.get(name);
  if (result.isError || !output) return result;
  const part = result.content.find((item) => item.type === output.type && item.mimeType === output.mime);
  if (!part || part.data.length > Math.ceil(output.limit / 3) * 4) throw new Error('Gateway did not return the expected media');
  const data = Buffer.from(part.data, 'base64');
  if (!data.length || data.length > output.limit || data.toString('base64') !== part.data) throw new Error('Gateway returned invalid media');
  const target = path.join(artifacts, randomUUID() + output.extension);
  await writeFile(target, data, { flag: 'wx', mode: 0o600 });
  return textResult({ path: target, mimeType: output.mime, bytes: data.length });
}

const server = new Server({ name: 'oh-my-harness-files', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler('tools/list', async (request, { signal }) => withGatewayClient(url, readKey(), async (client, deadline) => {
  const result = await client.listTools(request.params, { signal: deadline });
  return { ...result, tools: result.tools.map(localTool) };
}, signal));
server.setRequestHandler('tools/call', async ({ params }, { signal }) => {
  try {
    const args = await wireArgs(params.name, params.arguments ?? {});
    return await withGatewayClient(url, readKey(), async (client, deadline) => {
      const result = await client.callTool({ name: params.name, arguments: args }, { signal: deadline, timeout: 180_000 });
      return localResult(params.name, result);
    }, signal);
  } catch (error) {
    const message = error.code === 'ENOENT' ? 'The input file is missing' : error.message;
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
});
await server.connect(new StdioServerTransport());
