// Explicit build/test-process resolver. Never import this from a running host plugin.
// DSH_NODE_MODULES alone selects build input; it does not change ESM dependency lookup.
import { registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const configured = process.env.DSH_NODE_MODULES;
if (!configured || !path.isAbsolute(configured)) throw new Error('Set an absolute DSH_NODE_MODULES for native build/test dependency resolution');
const anchor = realpathSync(configured);
if (path.basename(anchor) !== 'node_modules') throw new Error('DSH_NODE_MODULES must resolve to the host node_modules directory');
const parentURL = pathToFileURL(path.join(path.dirname(anchor), '__oh_my_harness_host_anchor__.mjs')).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/') || specifier === '@earendil-works/pi-ai' || specifier.startsWith('@earendil-works/pi-ai/')) {
      // Retain the caller's import conditions. pi-ai intentionally has no require export.
      return nextResolve(specifier, { ...context, parentURL });
    }
    return nextResolve(specifier, context);
  },
});
