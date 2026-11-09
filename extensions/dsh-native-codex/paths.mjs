import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dshHome = path.resolve(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'));
const localModules = fileURLToPath(new URL('node_modules/', import.meta.url));
const dshNodeModules = path.resolve(process.env.DSH_NODE_MODULES ?? localModules);
export const upstreamAdapter = path.join(dshNodeModules, '@deepseek-ai/dsh-llm-pi-ai');
const stateDirectory = path.resolve(process.env.DSH_NATIVE_STATE_DIR ?? path.join(dshHome, 'native-codex'));
export const stateRoot = pathToFileURL(stateDirectory + path.sep);
