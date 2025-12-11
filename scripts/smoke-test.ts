#!/usr/bin/env bun

import { $ } from 'bun';

/**
 * Smart dataset resolution like archiscan
 */
function resolveTestDataset(input: string): string {
  // If full path, use as-is
  if (input.includes('/') || input.includes('\\')) {
    return input;
  }

  // If already prefixed, use as-is
  if (input.startsWith('testfolder-')) {
    return `./${input}`;
  }

  // Smart prefix
  return `./testfolder-${input}`;
}

const platform = Bun.argv[2]; // "linux" or "windows"
const dataset = Bun.argv[3] || 'small';
const testDir = resolveTestDataset(dataset);

console.log(`🧪 ${platform} smoke test: ${dataset} → ${testDir}`);

if (platform === 'linux') {
  await $`podman run --rm \
    -v ./dist/archifiltre-linux:/usr/local/bin/archifiltre:Z \
    -v ${testDir}:/test-data:Z \
    registry.access.redhat.com/ubi8/ubi:latest \
    sh -c 'chmod +x /usr/local/bin/archifiltre && archifiltre scan /test-data'`;
} else if (platform === 'windows') {
  await $`podman run --rm \
    -v ./dist/archifiltre-windows.exe:/app/archifiltre.exe:Z \
    -v ${testDir}:/test-data:Z \
    docker.io/scottyhardy/docker-wine \
    sh -c 'wine /app/archifiltre.exe scan /test-data'`;
}
