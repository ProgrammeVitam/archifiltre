#!/usr/bin/env bun

/**
 * SPDX 3.0 SBOM Generator for Archifiltre
 *
 * Generates Software Bill of Materials in SPDX 3.0 format using containerized
 * official Python spdx-tools library. Integrates with security audit results
 * to provide enhanced SBOM data with vulnerability information.
 *
 * This script follows the same containerized pattern as the security audit
 * tooling for consistency and maintainability.
 *
 * Usage: bun run scripts/generate-spdx3-sbom.ts [options]
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, relative } from 'path';

// ============================================================================
// Type Definitions
// ============================================================================

interface Spdx3Config {
  outputDir: string;
  includeDevDeps: boolean;
  quiet: boolean;
  verbose: boolean;
  buildContainer: boolean;
  forceRebuild: boolean;
  securityIntegration: boolean;
}

interface ContainerImage {
  name: string;
  tag: string;
  fullName: string;
  containerfile: string;
  estimatedSize: string;
}

interface ImageStatus {
  isBuilt: boolean;
  needsRebuild: boolean;
  buildRequired: boolean;
}

interface Spdx3Results {
  success: boolean;
  outputFile?: string;
  elementCount: number;
  securityVulnerabilities: number;
  securityFindings: number;
  errors: string[];
  warnings: string[];
  timestamp: string;
}

// ============================================================================
// Main Class
// ============================================================================

class Spdx3Generator {
  private config: Spdx3Config;
  private results: Spdx3Results;
  private containerImage: ContainerImage;
  private containerDir: string;
  private securityReportsDir: string;

  constructor() {
    this.config = this.parseArgs();
    this.containerDir = join(process.cwd(), 'containers', 'spdx3-generator');
    this.securityReportsDir = join(process.cwd(), 'security-reports');

    this.containerImage = {
      name: 'archifiltre-spdx3-generator',
      tag: 'latest',
      fullName: 'localhost/archifiltre-spdx3-generator:latest',
      containerfile: join(this.containerDir, 'Containerfile'),
      estimatedSize: '120MB',
    };

    this.results = {
      success: false,
      elementCount: 0,
      securityVulnerabilities: 0,
      securityFindings: 0,
      errors: [],
      warnings: [],
      timestamp: new Date().toISOString(),
    };
  }

  private parseArgs(): Spdx3Config {
    const args = process.argv.slice(2);
    const config: Spdx3Config = {
      outputDir: 'dist/sbom',
      includeDevDeps: true,
      quiet: false,
      verbose: false,
      buildContainer: true,
      forceRebuild: false,
      securityIntegration: true,
    };

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const nextArg = args[i + 1];

      switch (arg) {
        case '--help':
        case '-h':
          this.showHelp();
          process.exit(0);
          break;

        case '--output-dir':
        case '-o':
          if (nextArg && !nextArg.startsWith('-')) {
            config.outputDir = nextArg;
            i++;
          } else {
            throw new Error('--output-dir requires a directory path');
          }
          break;

        case '--exclude-dev-deps':
          config.includeDevDeps = false;
          break;

        case '--quiet':
        case '-q':
          config.quiet = true;
          break;

        case '--verbose':
        case '-v':
          config.verbose = true;
          break;

        case '--no-container-build':
          config.buildContainer = false;
          break;

        case '--force-rebuild':
          config.forceRebuild = true;
          break;

        case '--no-security':
          config.securityIntegration = false;
          break;

        default:
          if (arg.startsWith('-')) {
            throw new Error(`Unknown option: ${arg}`);
          }
          break;
      }
    }

    return config;
  }

  private showHelp(): void {
    console.log(`
Archifiltre SPDX 3.0 SBOM Generator
===================================

Usage: bun run scripts/generate-spdx3-sbom.ts [options]

Options:
  -h, --help              Show this help message
  -o, --output-dir DIR    Output directory (default: dist/sbom)
  --exclude-dev-deps      Exclude development dependencies
  -q, --quiet             Suppress output messages
  -v, --verbose           Enable verbose output
  --no-container-build    Skip container build/check
  --force-rebuild         Force container rebuild
  --no-security           Skip security data integration

Examples:
  bun run scripts/generate-spdx3-sbom.ts
  bun run scripts/generate-spdx3-sbom.ts --output-dir compliance-sbom --verbose
  bun run scripts/generate-spdx3-sbom.ts --exclude-dev-deps --quiet

SPDX 3.0 SBOM Generator
Organization: République française – Ministère de la Culture (SNUM)
Program: VITAM (Programme interministériel)
License: Apache-2.0
`);
  }

  public async run(): Promise<void> {
    try {
      if (!this.config.quiet) {
        console.log('Archifiltre SPDX 3.0 SBOM Generator');
        console.log('====================================');
      }

      // Check Podman availability
      this.checkPodman();

      // Setup output directory
      this.setupOutputDirectory();

      // Manage container image
      if (this.config.buildContainer) {
        await this.manageContainerImage();
      }

      // Run SPDX 3.0 generation
      await this.runSpdx3Container();

      // Generate summary
      this.generateSummary();
    } catch (error) {
      this.results.errors.push((error as Error).message);
      if (!this.config.quiet) {
        console.error(`\nSPDX 3.0 generation failed: ${(error as Error).message}`);
      }
      process.exit(1);
    }
  }

  private checkPodman(): void {
    try {
      execSync('podman --version', { stdio: 'pipe' });
    } catch (_error) {
      throw new Error(
        'Podman is required but not available. Please install podman: https://podman.io/getting-started/installation'
      );
    }
  }

  private setupOutputDirectory(): void {
    if (!existsSync(this.config.outputDir)) {
      mkdirSync(this.config.outputDir, { recursive: true });
    }
  }

  private async manageContainerImage(): Promise<void> {
    if (!this.config.quiet) {
      process.stdout.write('Checking SPDX 3.0 container... ');
    }

    const imageStatus = this.checkImageStatus();

    if (imageStatus.buildRequired || this.config.forceRebuild) {
      if (!this.config.quiet) {
        console.log('building container');
        process.stdout.write('Building SPDX 3.0 container... ');
      }

      await this.buildContainer();

      if (!this.config.quiet) {
        console.log('done');
      }
    } else {
      if (!this.config.quiet) {
        console.log('ready');
      }
    }
  }

  private checkImageStatus(): ImageStatus {
    try {
      // Check if container image exists
      execSync(`podman image exists ${this.containerImage.fullName}`, { stdio: 'pipe' });

      // Check if Containerfile is newer than image
      const imageInfo = execSync(
        `podman image inspect ${this.containerImage.fullName} --format "{{.Created}}"`,
        { stdio: 'pipe', encoding: 'utf-8' }
      ).trim();

      const imageDate = new Date(imageInfo);
      const containerfileStats = statSync(this.containerImage.containerfile);
      const containerfileDate = containerfileStats.mtime;

      return {
        isBuilt: true,
        needsRebuild: containerfileDate > imageDate,
        buildRequired: containerfileDate > imageDate,
      };
    } catch (_error) {
      return {
        isBuilt: false,
        needsRebuild: false,
        buildRequired: true,
      };
    }
  }

  private async buildContainer(): Promise<void> {
    try {
      // Copy Python script to container build context
      const pythonScript = readFileSync(
        join(__dirname, '..', 'containers', 'spdx3-generator', 'generate-spdx3.py')
      );
      writeFileSync(join(this.containerDir, 'generate-spdx3.py'), pythonScript);

      // Build container
      execSync(
        `podman build -t ${this.containerImage.fullName} -f ${this.containerImage.containerfile} ${this.containerDir}`,
        {
          stdio: this.config.verbose ? 'inherit' : 'pipe',
          timeout: 300000, // 5 minutes timeout
        }
      );
    } catch (_error) {
      throw new Error(`Failed to build SPDX 3.0 container: ${(_error as Error).message}`);
    }
  }

  private async runSpdx3Container(): Promise<void> {
    if (!this.config.quiet) {
      process.stdout.write('Generating SPDX 3.0 SBOM... ');
    }

    try {
      const startTime = Date.now();

      // Prepare container arguments
      const containerArgs = [
        'podman',
        'run',
        '--rm',
        `-v`,
        `${process.cwd()}:/workspace:ro`,
        `-v`,
        `${join(process.cwd(), this.config.outputDir)}:/output:rw`,
        `-v`,
        `${this.securityReportsDir}:/security-reports:ro`,
        `--workdir`,
        '/workspace',
        this.containerImage.fullName,
      ];

      // Add generator arguments
      if (this.config.includeDevDeps) {
        containerArgs.push('--include-dev-deps');
      } else {
        containerArgs.push('--exclude-dev-deps');
      }
      if (this.config.quiet) {
        containerArgs.push('--quiet');
      }

      // Run container
      const output = execSync(containerArgs.join(' '), {
        stdio: 'pipe',
        timeout: 120000, // 2 minutes timeout
        encoding: 'utf-8',
      });

      // Parse output for statistics
      this.parseGenerationOutput(output);

      this.results.success = true;
      const endTime = Date.now();
      const duration = ((endTime - startTime) / 1000).toFixed(1);

      if (!this.config.quiet) {
        console.log(`done (${duration}s)`);
      }

      if (this.config.verbose) {
        console.log('\nContainer output:');
        console.log(output);
      }
    } catch (error) {
      this.results.errors.push(`SPDX 3.0 generation failed: ${(error as Error).message}`);
      if (!this.config.quiet) {
        console.log('failed');
        console.error(`Error: ${(error as Error).message}`);
      }
      throw error;
    }
  }

  private parseGenerationOutput(output: string): void {
    const lines = output.split('\n');

    for (const line of lines) {
      // Parse element count
      const elementsMatch = line.match(/Created payload with (\d+) elements/);
      if (elementsMatch) {
        this.results.elementCount = parseInt(elementsMatch[1], 10);
      }

      // Parse security data
      const securityMatch = line.match(/(\d+) vulnerabilities, (\d+) findings/);
      if (securityMatch) {
        this.results.securityVulnerabilities = parseInt(securityMatch[1], 10);
        this.results.securityFindings = parseInt(securityMatch[2], 10);
      }

      // Parse output file
      const fileMatch = line.match(/Output File: (.+)/);
      if (fileMatch) {
        this.results.outputFile = fileMatch[1];
      }

      // Capture warnings
      if (line.includes('WARN:') || line.includes('Warning:')) {
        this.results.warnings.push(line);
      }
    }
  }

  private generateSummary(): void {
    if (!this.config.quiet) {
      console.log('');
      console.log('Generation Summary:');
      console.log(`  SPDX version: 3.0.1`);
      console.log(`  Total elements: ${this.results.elementCount}`);
      console.log(`  Output directory: ${this.config.outputDir}`);

      if (this.results.outputFile) {
        console.log(`  Output file: ${relative(process.cwd(), this.results.outputFile)}`);
      }

      if (this.config.securityIntegration) {
        console.log(
          `  Security data: ${this.results.securityVulnerabilities} vulnerabilities, ${this.results.securityFindings} findings`
        );
      }

      if (this.results.warnings.length > 0) {
        console.log(`  Warnings: ${this.results.warnings.length}`);
      }

      console.log('');
      console.log('SPDX 3.0 generation completed successfully');
    }
  }
}

// ============================================================================
// Main Execution
// ============================================================================

const generator = new Spdx3Generator();

// Handle process signals
process.on('SIGINT', () => {
  console.log('\n\nReceived SIGINT. Cleaning up...');
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('\n\nReceived SIGTERM. Cleaning up...');
  process.exit(1);
});

// Run generator
generator.run().catch(error => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});
