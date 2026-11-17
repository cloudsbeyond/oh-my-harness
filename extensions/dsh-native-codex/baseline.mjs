import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const expectedVersion = '0.2.2-rc.3';
export const expectedHash = 'e956da3d7300e1426e13e14f47e6f981dd1ca345633a406568ee5058ad93e9d8';
const expectedLlmHash = '6384b5f1e21404e997a41a31a22a079c9533f2ddc1ffd9148e684884ff62eb74';
const packageNames = ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-pi-ai', '@earendil-works/pi-ai', '@deepseek-ai/cordis', '@deepseek-ai/schemastery'];
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function packageRoot(entry, expectedName) {
  let directory = path.dirname(entry);
  for (let depth = 0; depth < 12; depth++) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
      if (manifest.name === expectedName) return directory;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('Could not identify the resolved Native Codex host dependency');
}

/** Capture actual ESM resolution, not guessed import-only package.json exports. */
export function captureDependencies({ anchor } = {}) {
  const packages = {};
  for (const name of packageNames) {
    const entry = fileURLToPath(import.meta.resolve(name));
    const root = packageRoot(entry, name);
    if (anchor && realpathSync(path.join(anchor, name)) !== realpathSync(root)) throw new Error('Native build dependency anchor differs from actual ESM resolution');
    const raw = readFileSync(path.join(root, 'package.json'));
    const { version } = JSON.parse(raw);
    const relative = path.relative(root, entry);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Native dependency entry leaves its package');
    packages[name] = { version, manifestHash: sha256(raw), entry: relative.split(path.sep).join('/'), entryHash: sha256(readFileSync(entry)) };
  }
  const valid = packages['@deepseek-ai/dsh-llm'].version === expectedVersion && packages['@deepseek-ai/dsh-llm'].entryHash === expectedLlmHash &&
    packages['@deepseek-ai/dsh-llm-pi-ai'].version === expectedVersion && packages['@deepseek-ai/dsh-llm-pi-ai'].entryHash === expectedHash &&
    ['1.3.0', '1.5.2'].includes(packages['@earendil-works/pi-ai'].version) && packages['@deepseek-ai/cordis'].version === '4.1.0' && packages['@deepseek-ai/schemastery'].version === '3.19.0';
  if (!valid) throw new Error('Native Codex host baseline is not reviewed; validate and update its version/content locks before building');
  return { format: 1, packages };
}

/** Fail before route registration when a built release runs against a different baseline. */
export function verifyDependencies(expected) {
  const mismatch = () => Object.assign(new Error('Native Codex dependencies changed; rebuild and validate against the selected host'), { code: 'NATIVE_DEPENDENCY_MISMATCH' });
  let actual;
  try { actual = captureDependencies(); } catch { throw mismatch(); }
  if (!expected || expected.format !== 1 || !expected.packages || Object.keys(expected.packages).length !== packageNames.length) throw mismatch();
  for (const name of packageNames) {
    const entry = expected.packages[name];
    const current = actual.packages[name];
    if (!entry || Object.keys(entry).length !== Object.keys(current).length || Object.keys(current).some((key) => entry[key] !== current[key])) throw mismatch();
  }
  return actual;
}
