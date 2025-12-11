/**
 * Copy WASM files from node_modules to wasm_binaries for compilation
 */

import { promises as fs } from 'node:fs';

const WASM_FILES = [
  {
    source: 'node_modules/@electric-sql/pglite/dist/pglite.wasm',
    dest: 'wasm_binaries/pglite.wasm',
  },
  {
    source: 'node_modules/@electric-sql/pglite/dist/pglite.data',
    dest: 'wasm_binaries/pglite.data',
  },
  {
    source: 'node_modules/libarchive-wasm/dist/libarchive.wasm',
    dest: 'wasm_binaries/libarchive.wasm',
  },
];

async function copyWasmFiles(): Promise<void> {
  await fs.mkdir('wasm_binaries', { recursive: true });

  for (const { source, dest } of WASM_FILES) {
    try {
      await fs.copyFile(source, dest);
    } catch (error) {
      console.error(`Failed to copy ${source}:`, error);
      process.exit(1);
    }
  }

  console.log('WASM binaries copied');
}

copyWasmFiles().catch(console.error);
