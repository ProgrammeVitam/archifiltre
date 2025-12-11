/**
 * Smart libarchive WASM initialization
 * Uses automatic loading in development, manual loading in compiled binaries
 */

import { ArchiveReader } from 'libarchive-wasm';
import { isStandalone } from '@lib/platform-paths.ts';
import { logger } from '@lib/logging.ts';

// Import libarchive WASM file for bundled executable (embedded at build time)
import wasmPath from '../../wasm_binaries/libarchive.wasm' with { type: 'file' };

// Dynamic imports to avoid bundling issues
let libarchiveWasm: any = null;
let wasmModule: any = null;

/**
 * Initialize libarchive WASM module with automatic dev/standalone detection
 */
export async function initializeLibarchiveWasm(): Promise<any> {
  if (wasmModule) {
    return wasmModule; // Return cached module
  }

  if (isStandalone()) {
    // Compiled binary: use manual WASM loading with bundled WASM file
    try {
      if (!libarchiveWasm) {
        // Import the libarchiveWasm wrapper function (not the raw libarchive)
        const { libarchiveWasm: wasmLoader } = await import('libarchive-wasm');
        libarchiveWasm = wasmLoader;
      }

      // Provide custom locateFile function to use our bundled WASM
      wasmModule = await libarchiveWasm({
        locateFile: (path: string) => {
          if (path === 'libarchive.wasm') {
            return wasmPath; // Return path to our bundled WASM file
          }
          return path; // Fallback for other files
        },
      });

      logger.debug('Successfully initialized libarchive WASM in standalone mode');
      return wasmModule;
    } catch (error) {
      logger.error('Failed to initialize libarchive WASM in standalone mode', {
        error: error.message,
      });
      throw new Error(`WASM initialization failed: ${error.message}`);
    }
  } else {
    // Development mode: use normal libarchive-wasm loading
    try {
      if (!libarchiveWasm) {
        const { libarchiveWasm: wasmLoader } = await import('libarchive-wasm');
        libarchiveWasm = wasmLoader;
      }
      wasmModule = await libarchiveWasm();
      return wasmModule;
    } catch (error) {
      logger.error('Failed to initialize libarchive WASM in development mode', {
        error: error.message,
      });
      throw new Error(`WASM initialization failed: ${error.message}`);
    }
  }
}

export { ArchiveReader };
