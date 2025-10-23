#!/usr/bin/env bun
/**
 * Release Packaging Script for Archifiltre
 *
 * Creates release packages with:
 * - Compiled binary
 * - LICENSE file
 * - README.quickstart.md
 * - SHA256 checksums
 * - manifest.json with file metadata
 *
 * Output: dist/archifiltre-${os}-${arch}-${version}.tar.gz
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { readFile, writeFile, mkdir, copyFile, chmod, stat, rm, readdir } from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { pipeline } from 'stream/promises';
import { createGzip } from 'zlib';
import { pack } from 'tar-stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = dirname(__dirname);

interface BuildInfo {
  version: string;
  gitSha: string;
  buildDate: string;
  os: string;
  arch: string;
}

interface FileInfo {
  name: string;
  size: number;
  sha256: string;
  mode: number;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface ManifestData {
  version: string;
  generated: string;
  files: FileInfo[];
}

interface ReleaseFiles {
  releaseDir: string;
  files: string[];
}

/**
 * ANSI color codes
 */
const colors: Record<string, string> = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};

/**
 * Formats colored output
 */
function colorize(text: string, color: string): string {
  if (process.env.NO_COLOR === '1' || process.env.CI === 'true') {
    return text;
  }
  return `${colors[color]}${text}${colors.reset}`;
}

/**
 * Logs a message with timestamp
 */
function log(message: string, color: string = 'reset'): void {
  const timestamp = new Date().toISOString();
  console.log(`${colorize(`[${timestamp}]`, 'gray')} ${colorize(message, color)}`);
}

/**
 * Runs bun command with specified args
 * Uses hardcoded 'bun' command to prevent command injection
 */
function runBunCommand(
  args: string[] = [],
  options: Record<string, unknown> = {}
): Promise<CommandResult> {
  const command = 'bun'; // Hardcoded to prevent command injection

  return new Promise((resolve, reject) => {
    log(`Running: ${command} ${args.join(' ')}`, 'blue');

    const child = spawn(command, args, {
      stdio: 'pipe',
      cwd: projectRoot,
      ...options,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', data => {
      stdout += data.toString();
    });

    child.stderr?.on('data', data => {
      stderr += data.toString();
    });

    child.on('close', code => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr.trim() || stdout.trim()}`));
      }
    });

    child.on('error', reject);
  });
}

/**
 * Gets build information from environment or package.json
 */
async function getBuildInfo(): Promise<BuildInfo> {
  try {
    const packageJsonPath = join(projectRoot, 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));

    return {
      version: process.env.APP_VERSION || packageJson.version || '5.0.0-dev',
      gitSha: process.env.GIT_SHA || process.env.GITHUB_SHA || 'unknown',
      buildDate: process.env.BUILD_DATE || new Date().toISOString(),
      os: getOsName(),
      arch: getArchName(),
    };
  } catch (error) {
    log(
      `Warning: Could not read package.json: ${error instanceof Error ? error.message : String(error)}`,
      'yellow'
    );
    return {
      version: '5.0.0-dev',
      gitSha: 'unknown',
      buildDate: new Date().toISOString(),
      os: getOsName(),
      arch: getArchName(),
    };
  }
}

/**
 * Gets normalized OS name
 */
function getOsName(): string {
  const platform = process.env.TARGET_OS || process.platform;
  switch (platform) {
    case 'darwin':
      return 'darwin';
    case 'win32':
      return 'win32';
    case 'linux':
      return 'linux';
    default:
      return platform;
  }
}

/**
 * Gets normalized architecture name
 */
function getArchName(): string {
  const arch = process.env.TARGET_ARCH || process.arch;
  switch (arch) {
    case 'x64':
      return 'x64';
    case 'arm64':
      return 'arm64';
    case 'arm':
      return 'arm';
    default:
      return arch;
  }
}

/**
 * Calculates SHA256 hash of a file
 */
async function calculateFileHash(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);

  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Gets file stats including size
 */
async function getFileInfo(filePath: string): Promise<FileInfo> {
  const stats = await stat(filePath);
  const hash = await calculateFileHash(filePath);

  return {
    name: basename(filePath),
    size: stats.size,
    sha256: hash,
    mode: stats.mode,
  };
}

/**
 * Builds the CLI binary
 */
async function buildBinary(buildInfo: BuildInfo): Promise<string> {
  log('Building CLI binary...', 'bold');

  const binaryName = buildInfo.os === 'win32' ? 'archifiltre.exe' : 'archifiltre';
  const binaryPath = join(projectRoot, binaryName);

  // Set build environment variables
  const env = {
    ...process.env,
    APP_VERSION: buildInfo.version,
    GIT_SHA: buildInfo.gitSha,
    BUILD_DATE: buildInfo.buildDate,
  };

  try {
    await runBunCommand(['build', 'src/cli/archifiltre.ts', '--compile', '--outfile', binaryName], {
      env,
    });

    // Ensure binary is executable on Unix-like systems
    if (buildInfo.os !== 'win32') {
      await chmod(binaryPath, 0o755);
    }

    log(`✓ Binary built successfully: ${binaryName}`, 'green');
    return binaryPath;
  } catch (error) {
    log(
      `✗ Failed to build binary: ${error instanceof Error ? error.message : String(error)}`,
      'red'
    );
    throw error;
  }
}

/**
 * Creates README.quickstart.md
 */
async function createQuickStartReadme(buildInfo: BuildInfo): Promise<string> {
  const quickStartPath = join(projectRoot, 'README.quickstart.md');
  const binaryName = buildInfo.os === 'win32' ? 'archifiltre.exe' : 'archifiltre';

  const content = `# Archifiltre v${buildInfo.version} - Quick Start

Privacy-friendly, 100% offline file tree inventory tool.

## Installation

1. Extract the archive
2. Make the binary executable (Unix/Linux/macOS only):
   \`\`\`bash
   chmod +x ${binaryName}
   \`\`\`

## Basic Usage

\`\`\`bash
# Show help
./${binaryName} --help

# Show version
./${binaryName} --version

# Check system health
./${binaryName} health

# Enable verbose output
./${binaryName} --verbose health
\`\`\`

## Exit Codes

- \`0\` - Success
- \`1\` - System error (file I/O, permissions, etc.)
- \`2\` - Usage error (invalid flags, arguments, etc.)

## Support

- Issues: https://github.com/ProgrammeVitam/archifiltre/issues
- Documentation: https://github.com/ProgrammeVitam/archifiltre

---

Build Information:
- Version: ${buildInfo.version}
- Git SHA: ${buildInfo.gitSha}
- Build Date: ${buildInfo.buildDate}
- OS: ${buildInfo.os}
- Architecture: ${buildInfo.arch}
`;

  await writeFile(quickStartPath, content, 'utf-8');
  log(`✓ Created README.quickstart.md`, 'green');
  return quickStartPath;
}

/**
 * Prepares release directory with all files
 */
async function prepareReleaseFiles(
  buildInfo: BuildInfo,
  binaryPath: string
): Promise<ReleaseFiles> {
  const releaseDir = join(projectRoot, 'release-temp');

  // Clean up any existing release directory
  try {
    await rm(releaseDir, { recursive: true, force: true });
  } catch {
    // Ignore if doesn't exist
  }

  await mkdir(releaseDir, { recursive: true });
  log(`✓ Created release directory: ${releaseDir}`, 'green');

  // Copy binary
  const binaryName = basename(binaryPath);
  const releaseBinaryPath = join(releaseDir, binaryName);
  await copyFile(binaryPath, releaseBinaryPath);

  // Ensure binary is executable
  if (buildInfo.os !== 'win32') {
    await chmod(releaseBinaryPath, 0o755);
  }

  // Copy LICENSE
  const licensePath = join(projectRoot, 'LICENSE');
  const releaseLicensePath = join(releaseDir, 'LICENSE');
  await copyFile(licensePath, releaseLicensePath);

  // Create and copy quickstart README
  const quickStartPath = await createQuickStartReadme(buildInfo);
  const releaseReadmePath = join(releaseDir, 'README.quickstart.md');
  await copyFile(quickStartPath, releaseReadmePath);

  // Clean up temporary quickstart README
  await rm(quickStartPath);

  log(`✓ Copied all files to release directory`, 'green');

  return {
    releaseDir,
    files: [releaseBinaryPath, releaseLicensePath, releaseReadmePath],
  };
}

/**
 * Creates manifest.json with file metadata
 */
async function createManifest(files: string[], _outputPath: string): Promise<string> {
  log('Creating manifest...', 'blue');

  const manifestData: ManifestData = {
    version: '1.0',
    generated: new Date().toISOString(),
    files: [],
  };

  for (const filePath of files) {
    const fileInfo = await getFileInfo(filePath);
    manifestData.files.push(fileInfo);
  }

  const manifestPath = join(dirname(files[0]), 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifestData, null, 2), 'utf-8');

  log(`✓ Created manifest.json`, 'green');
  return manifestPath;
}

/**
 * Creates SHA256 checksum file
 */
async function createChecksums(files: string[], outputDir: string): Promise<string> {
  log('Creating checksums...', 'blue');

  const checksums: string[] = [];

  for (const filePath of files) {
    const hash = await calculateFileHash(filePath);
    const fileName = basename(filePath);
    checksums.push(`${hash}  ${fileName}`);
  }

  const checksumPath = join(outputDir, 'checksums.sha256');
  await writeFile(checksumPath, checksums.join('\n') + '\n', 'utf-8');

  log(`✓ Created checksums.sha256`, 'green');
  return checksumPath;
}

/**
 * Creates tar.gz archive
 */
async function createArchive(releaseDir: string, outputPath: string): Promise<string> {
  log(`Creating archive: ${basename(outputPath)}...`, 'blue');

  const files = await readdir(releaseDir);
  const tarStream = pack();
  const gzipStream = createGzip({ level: 9 });
  const outputStream = createWriteStream(outputPath);

  // Add files to tar stream
  for (const fileName of files) {
    const filePath = join(releaseDir, fileName);
    const stats = await stat(filePath);
    const content = await readFile(filePath);

    tarStream.entry(
      {
        name: fileName,
        size: stats.size,
        mode: stats.mode,
      },
      content
    );
  }

  tarStream.finalize();

  // Pipeline: tar -> gzip -> file
  await pipeline(tarStream, gzipStream, outputStream);

  const archiveStats = await stat(outputPath);
  log(`✓ Created archive (${Math.round(archiveStats.size / 1024)} KB): ${outputPath}`, 'green');

  return outputPath;
}

/**
 * Main release packaging function
 */
async function createRelease(): Promise<void> {
  log('Starting Archifiltre Release Packaging', 'bold');
  log('======================================', 'bold');

  try {
    // Get build information
    const buildInfo = await getBuildInfo();
    log(`Version: ${buildInfo.version}`, 'blue');
    log(`Git SHA: ${buildInfo.gitSha}`, 'blue');
    log(`Target: ${buildInfo.os}-${buildInfo.arch}`, 'blue');

    // Build binary
    const binaryPath = await buildBinary(buildInfo);

    // Prepare release files
    const { releaseDir, files } = await prepareReleaseFiles(buildInfo, binaryPath);

    // Create manifest
    const manifestPath = await createManifest(files, releaseDir);
    files.push(manifestPath);

    // Create dist directory
    const distDir = join(projectRoot, 'dist');
    await mkdir(distDir, { recursive: true });

    // Create checksums
    const checksumPath = await createChecksums(files, distDir);

    // Create archive
    const archiveName = `archifiltre-${buildInfo.os}-${buildInfo.arch}-${buildInfo.version}.tar.gz`;
    const archivePath = join(distDir, archiveName);
    await createArchive(releaseDir, archivePath);

    // Create checksum for the archive itself
    const archiveHash = await calculateFileHash(archivePath);
    const archiveChecksumPath = join(distDir, `${archiveName}.sha256`);
    await writeFile(archiveChecksumPath, `${archiveHash}  ${archiveName}\n`, 'utf-8');

    // Copy manifest to dist
    const distManifestPath = join(distDir, 'manifest.json');
    await copyFile(manifestPath, distManifestPath);

    // Clean up temporary files
    await rm(releaseDir, { recursive: true });
    await rm(binaryPath);

    // Summary
    log('======================================', 'bold');
    log('Release Package Created Successfully!', 'bold');
    log('======================================', 'bold');
    log(`Archive: ${archivePath}`, 'green');
    log(`Checksums: ${checksumPath}`, 'green');
    log(`Archive checksum: ${archiveChecksumPath}`, 'green');
    log(`Manifest: ${distManifestPath}`, 'green');
    log(`Archive SHA256: ${archiveHash}`, 'gray');
  } catch (error) {
    log(
      `✗ Release packaging failed: ${error instanceof Error ? error.message : String(error)}`,
      'red'
    );
    process.exit(1);
  }
}

// Handle process signals
process.on('SIGINT', async () => {
  log('Release packaging interrupted', 'yellow');

  // Clean up temporary files
  try {
    await rm(join(projectRoot, 'release-temp'), { recursive: true, force: true });
    await rm(join(projectRoot, 'archifiltre'), { force: true });
    await rm(join(projectRoot, 'archifiltre.exe'), { force: true });
  } catch {
    // Ignore cleanup errors
  }

  process.exit(130);
});

process.on('SIGTERM', async () => {
  log('Release packaging terminated', 'yellow');
  process.exit(143);
});

// Run the release packaging
createRelease().catch(error => {
  log(`Fatal error: ${error.message}`, 'red');
  console.error(error.stack);
  process.exit(1);
});
