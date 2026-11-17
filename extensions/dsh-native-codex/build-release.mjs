import { readFile } from 'node:fs/promises';
import { publishRelease } from '../dsh-native/release.mjs';
import { buildRoot, runtimeFiles, stateRoot } from './paths.mjs';

// Dependency identity participates in the immutable release id, not just the adapter text.
const files = [...runtimeFiles, 'vendor/dsh-pi-adapter.mjs', 'vendor/LICENSE', 'vendor/dependencies.json'];
const inputs = new Map(await Promise.all(files.map(async (file) => [file, await readFile(new URL(file, buildRoot), 'utf8')])));
const statusAnchor = "new URL('runtime-status.json', import.meta.url)";
if (inputs.get('plugin.mjs').split(statusAnchor).length !== 2) throw new Error('Native release status path anchor is not unique');
inputs.set('plugin.mjs', inputs.get('plugin.mjs').replace(statusAnchor, "new URL('../../runtime-status.json', import.meta.url)"));
console.log(JSON.stringify(await publishRelease({ stateRoot, inputs })));
