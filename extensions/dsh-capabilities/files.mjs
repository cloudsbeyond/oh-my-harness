import { CapabilityError, documentMimeType, imageMimeType, limits, wavPcm } from '../../src/capabilities/contracts.mjs';

const fail = (message, code = 'INPUT_FILE_FORBIDDEN') => { throw new CapabilityError(message, code); };
const same = (fs, left, right) => fs.contains(left, right) && fs.contains(right, left);
const validRef = (block) => ['image', 'file'].includes(block?.type) && typeof block.attachment?.attachmentId === 'string' && /^sha256:[0-9a-f]{64}$/.test(block.attachment.attachmentId);

/** Host-only cloud admission. The filesystem's read capability is not an upload ACL. */
export function createFileAccess({ ownedToolNames = [] } = {}) {
  const ownedTools = new Set(ownedToolNames);
  const generated = new WeakMap();
  function remember(session, blocks) {
    if (!session) return;
    let refs = generated.get(session);
    if (!refs) { refs = new Map(); generated.set(session, refs); }
    for (const block of blocks) {
      if (!validRef(block)) continue;
      const key = block.type + ':' + block.attachment.attachmentId;
      refs.delete(key); refs.set(key, structuredClone(block));
      if (refs.size > 128) refs.delete(refs.keys().next().value);
    }
  }
  function visible(session) {
    const messages = session.deriveMessages();
    if (!Array.isArray(messages)) fail('Cannot verify current-session attachment provenance');
    const calls = new Set();
    for (const message of messages) {
      if (message.role !== 'assistant' || message.source?.kind !== 'model') continue;
      for (const block of message.content) if (block.type === 'tool-call' && ownedTools.has(block.name)) calls.add(block.id);
    }
    const refs = [];
    for (const message of messages) {
      const user = message.role === 'user' && message.source?.kind === 'user';
      const ownResult = message.role === 'tool' && message.source?.kind === 'tool' && !message.isError &&
        message.toolCallId === message.source.callId && calls.has(message.toolCallId);
      if (user || ownResult) for (const block of message.content) if (validRef(block)) refs.push(block);
    }
    return [...refs.reverse(), ...[...(generated.get(session)?.values() ?? [])].reverse()];
  }
  async function read(ctx, exec, filePath, { kind, maxBytes = limits.fileBytes }) {
    const { agent, signal } = exec;
    signal?.throwIfAborted();
    if (!agent?.session || typeof agent.session.deriveMessages !== 'function') fail('A live Agent session is required for cloud file processing', 'AGENT_REQUIRED');
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.length > 4096 || filePath.includes('\0') || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > limits.fileBytes) fail('Invalid native file input or byte limit', 'INPUT_INVALID');
    const cwd = await ctx.workingDirectory.ensure(agent, signal);
    const target = await ctx.fs.resolve(filePath, { cwd, signal });
    const policy = ctx.sandboxPolicy.resolve({ session: agent.session });
    const root = await ctx.fs.resolve(policy.workspaceRoot, { signal });
    let admitted = ctx.fs.contains(root, target);
    let trustedName;
    for (const block of visible(agent.session)) {
      signal?.throwIfAborted();
      const hostPath = block.type === 'file' ? ctx.attachments.fileHostPath(block.attachment) : ctx.attachments.imageHostPath(block.attachment);
      const mapped = hostPath && ctx.fs.processPathFromHostPath(hostPath);
      if (!mapped) continue;
      const known = await ctx.fs.resolve(mapped, { signal });
      if (same(ctx.fs, known, target)) { admitted = true; trustedName = block.attachment.name; break; }
    }
    if (!admitted) fail('Only session workspace files, user-attached files, or this plugin\'s session artifacts may be sent to a provider');
    signal?.throwIfAborted();
    const before = await ctx.fs.stat(target, signal);
    if (!before || before.type !== 'file') fail('The admitted input must be an existing regular file', 'INPUT_FILE_INVALID');
    if (before.size !== undefined && (before.size < 1 || before.size > maxBytes)) fail('Input file exceeds the supported byte limit or is empty', 'INPUT_TOO_LARGE');
    const data = await ctx.fs.readBytes(target, signal, maxBytes);
    signal?.throwIfAborted();
    if (!(data instanceof Uint8Array) || !data.byteLength || data.byteLength > maxBytes) fail('Filesystem returned invalid or oversized input bytes', 'INPUT_TOO_LARGE');
    const current = await ctx.fs.resolve(filePath, { cwd, signal });
    const after = await ctx.fs.stat(current, signal);
    if (!same(ctx.fs, target, current) || !after || after.type !== 'file' || before.version !== after.version) fail('Input file changed during admission; select it again', 'INPUT_FILE_CHANGED');
    const name = trustedName ?? ctx.fs.processPath(target).split(/[\\/]/).at(-1);
    if (typeof name !== 'string' || !name || Buffer.byteLength(name) > 255 || /[\\/\x00-\x1f\x7f]/.test(name)) fail('Input filename is unsupported', 'INPUT_INVALID');
    let mimeType;
    try {
      if (kind === 'image') mimeType = imageMimeType(data);
      else if (kind === 'document') mimeType = documentMimeType(name, data);
      else if (kind === 'video') mimeType = 'video/mp4';
      else if (kind === 'audio') { wavPcm(data); mimeType = 'audio/wav'; }
      else fail('Unsupported native media operation', 'INPUT_INVALID');
    } catch (error) {
      if (error instanceof CapabilityError) throw error;
      fail('Input format does not match the supported media contract', 'INPUT_INVALID');
    }
    return { data, name, mimeType };
  }
  return { read, remember };
}
