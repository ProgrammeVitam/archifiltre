/**
 * streamarchive WASM initialization
 *
 * Development / plain `bun run`: nothing to do — the package's default loader finds
 * the WASM inside node_modules. Compiled sidecar (`bun build --compile`): the package
 * layout is gone, so the WASM is embedded into the executable at build time (the
 * `type: 'file'` import below; scripts/copy-wasm.ts stages it) and injected explicitly.
 *
 * `initStreamArchive` is idempotent, but we still memoize the whole decision here so
 * every archive call site can cheaply `await ensureStreamArchive()` first.
 */

import { initStreamArchive } from 'streamarchive';
import { isStandalone } from '@lib/platform-paths.ts';
import { logger } from '@lib/logging.ts';

// Embedded at build time by `bun build --compile`; a plain file path in dev.
import wasmPath from '../../wasm_binaries/streamarchive.wasm' with { type: 'file' };

let initialized: Promise<void> | null = null;

export function ensureStreamArchive(): Promise<void> {
  if (!initialized) {
    initialized = (async () => {
      if (isStandalone()) {
        await initStreamArchive({ wasmBinary: await Bun.file(wasmPath).arrayBuffer() });
        logger.debug('streamarchive WASM initialized (standalone, embedded binary)');
      }
      // Dev: default in-package loading — no explicit init needed.
    })().catch(error => {
      initialized = null; // allow a retry rather than caching the failure forever
      throw error;
    });
  }
  return initialized;
}
