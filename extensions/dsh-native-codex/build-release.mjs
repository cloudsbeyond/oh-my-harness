import { readFile } from 'node:fs/promises';
import { publishRelease } from '../dsh-native/release.mjs';
import { stateRoot } from './paths.mjs';

const files = ['plugin.mjs', 'native-search.mjs', 'native-images.mjs', 'vendor/dsh-pi-adapter.mjs', 'vendor/LICENSE'];
const inputs = new Map(await Promise.all(files.map(async (file) => [
  file, await readFile(new URL(file, import.meta.url), 'utf8'),
])));
inputs.set('plugin.mjs', inputs.get('plugin.mjs')
  .replace("new URL('runtime-status.json', import.meta.url)", "new URL('../../runtime-status.json', import.meta.url)"));
const manifest = await publishRelease({ stateRoot, inputs });
console.log(JSON.stringify(manifest));
