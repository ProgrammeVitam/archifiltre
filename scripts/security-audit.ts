#!/usr/bin/env bun

/**
 * Security Audit Script for Archifiltre
 *
 * Container-orchestrated security scanning using Podman
 * - Semgrep for static code analysis
 * - Trivy for dependency vulnerability scanning
 *
 * Usage: bun run scripts/security-audit.ts [options]
 *
 * Options:
 *   --ci              CI mode (fail on findings)
 *   --json            Output JSON results
 *   --output <file>   Save report to file
 *   --quiet           Minimal output
 *   --skip-trivy      Skip dependency scan
 *   --skip-semgrep    Skip code security scan
 *   --severity <level> Minimum severity to fail (low, medium, high, critical)
 */

import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join, relative } from 'path';

interface Config {
  ci: boolean;
  json: boolean;
  output: string | null;
  quiet: boolean;
  skipTrivy: boolean;
  skipSemgrep: boolean;
  severity: string;
  containerTimeout: number;
  semgrepConfig: string;
  allowlist: string[];
  updateImages: boolean;
  offline: boolean;
  assumeYes: boolean;
  showDigests: boolean;
  checkOnly: boolean;
}

// Trivy JSON Output Interfaces
interface TrivyReport {
  SchemaVersion?: number;
  ArtifactName?: string;
  ArtifactType?: string;
  Metadata?: Record<string, unknown>;
  Results?: TrivyResult[];
}

interface TrivyResult {
  Target: string;
  Class?: string;
  Type?: string;
  Vulnerabilities?: TrivyVulnerability[];
  Misconfigurations?: unknown[];
  Secrets?: unknown[];
  Licenses?: unknown[];
}

interface TrivyVulnerability {
  VulnerabilityID: string;
  PkgName: string;
  PkgPath?: string;
  InstalledVersion: string;
  FixedVersion?: string;
  Status?: string;
  Layer?: Record<string, unknown>;
  SeveritySource?: string;
  PrimaryURL?: string;
  Title: string;
  Description: string;
  Severity: string;
  CweIDs?: string[];
  CVSS?: Record<string, unknown>;
  References?: string[];
  PublishedDate?: string;
  LastModifiedDate?: string;
}

// Semgrep JSON Output Interfaces
interface SemgrepReport {
  version?: string;
  results: SemgrepFinding[];
  errors: SemgrepError[];
  paths?: SemgrepPaths;
  skipped_rules?: unknown[];
}

interface SemgrepFinding {
  check_id: string;
  path: string;
  start: SemgrepPosition;
  end: SemgrepPosition;
  extra: SemgrepExtra;
}

interface SemgrepPosition {
  line: number;
  col: number;
  offset?: number;
}

interface SemgrepExtra {
  message: string;
  metadata?: SemgrepMetadata;
  severity?: string;
  fix?: string;
  fingerprint?: string;
  lines?: string;
}

interface SemgrepMetadata {
  owasp?: string[];
  cwe?: string[];
  category?: string;
  confidence?: string;
  impact?: string;
  likelihood?: string;
  subcategory?: string[];
  technology?: string[];
  references?: string[];
  source?: string;
}

interface SemgrepError {
  message: string;
  level?: string;
  type?: string;
  rule_id?: string;
}

interface SemgrepPaths {
  scanned?: string[];
  skipped?: unknown[];
}

// Container Image Management Interfaces
interface ContainerImage {
  name: string;
  registry: string;
  tag: string;
  fullName: string;
  estimatedSize: string;
}

interface ImageStatus {
  image: ContainerImage;
  isAvailable: boolean;
  hasUpdate: boolean;
  localDigest?: string;
  remoteDigest?: string;
  needsDownload: boolean;
  version?: string;
  age?: string;
  remoteVersion?: string;
  remoteAge?: string;
}

interface ImageCheckResult {
  trivy: ImageStatus;
  semgrep: ImageStatus;
  hasUpdates: boolean;
  needsSetup: boolean;
}

interface ToolStatus {
  success: boolean;
  issues: number;
  skipped: boolean;
}

interface Summary {
  totalIssues: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  tools: {
    trivy: ToolStatus;
    semgrep: ToolStatus;
  };
}

interface Vulnerability {
  id: string;
  package: string;
  version: string;
  fixedVersion?: string;
  severity: string;
  title: string;
  description: string;
  references: string[];
  cvss?: Record<string, unknown>;
  path: string;
}

interface Finding {
  ruleId: string;
  message: string;
  severity: string;
  file: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  confidence?: string;
  owasp?: string[];
  cwe?: string[];
  fix?: string;
}

interface Results {
  summary: Summary;
  trivy: { vulnerabilities: Vulnerability[]; errors: string[] };
  semgrep: { findings: Finding[]; errors: string[] };
  timestamp: string;
}

class SecurityAuditor {
  private config: Config;
  private results: Results;
  private reportsDir: string;
  private images: { trivy: ContainerImage; semgrep: ContainerImage };

  constructor() {
    this.config = this.parseArgs();
    this.reportsDir = join(process.cwd(), 'security-reports');
    this.images = {
      trivy: {
        name: 'trivy',
        registry: 'docker.io',
        tag: 'latest',
        fullName: 'docker.io/aquasec/trivy:latest',
        estimatedSize: '45MB',
      },
      semgrep: {
        name: 'semgrep',
        registry: 'docker.io',
        tag: 'latest',
        fullName: 'docker.io/returntocorp/semgrep:latest',
        estimatedSize: '85MB',
      },
    };
    this.results = {
      summary: {
        totalIssues: 0,
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        tools: {
          trivy: { success: false, issues: 0, skipped: false },
          semgrep: { success: false, issues: 0, skipped: false },
        },
      },
      trivy: { vulnerabilities: [], errors: [] },
      semgrep: { findings: [], errors: [] },
      timestamp: new Date().toISOString(),
    };
  }

  private parseArgs(): Config {
    const args = process.argv.slice(2);
    const config: Config = {
      ci: false,
      json: false,
      output: null,
      quiet: false,
      skipTrivy: false,
      skipSemgrep: false,
      severity: 'medium',
      containerTimeout: 600, // 10 minutes for container operations
      semgrepConfig: 'p/security-audit',
      allowlist: [],
      updateImages: false,
      offline: false,
      assumeYes: false,
      showDigests: false,
      checkOnly: false,
    };

    for (let i = 0; i < args.length; i++) {
      switch (args[i]) {
        case '--ci':
          config.ci = true;
          break;
        case '--json':
          config.json = true;
          break;
        case '--output':
          config.output = args[++i];
          break;
        case '--quiet':
          config.quiet = true;
          break;
        case '--skip-trivy':
          config.skipTrivy = true;
          break;
        case '--skip-semgrep':
          config.skipSemgrep = true;
          break;
        case '--severity':
          config.severity = args[++i];
          break;
        case '--update-images':
          config.updateImages = true;
          break;
        case '--offline':
          config.offline = true;
          break;
        case '--assume-yes':
        case '--yes':
          config.assumeYes = true;
          break;
        case '--show-digests':
          config.showDigests = true;
          break;
        case '--check-only':
          config.checkOnly = true;
          break;
        case '--help':
          this.showHelp();
          process.exit(0);
      }
    }

    return config;
  }

  private showHelp(): void {
    console.log(`Security Audit Script

Usage: bun run scripts/security-audit.ts [options]

Options:
  --ci                 CI mode (fail on findings above severity threshold)
  --json               Output results as JSON
  --output <file>      Save report to specified file
  --quiet              Minimal console output
  --skip-trivy         Skip dependency vulnerability scan
  --skip-semgrep       Skip static security analysis
  --severity <level>   Minimum severity to fail on (low|medium|high|critical)
  --update-images      Force check and update all container images
  --offline            Use cached images only, no network calls
  --assume-yes, --yes  Auto-accept all downloads and updates
  --show-digests       Display image digest hashes
  --check-only         Show image status without downloading
  --help               Show this help

Requirements:
  - Podman installed and available in PATH

Examples:
  bun run scripts/security-audit.ts
  bun run scripts/security-audit.ts --ci --severity high
  bun run scripts/security-audit.ts --json --output security-report.json
  bun run scripts/security-audit.ts --update-images --assume-yes`);
  }

  public async run(): Promise<void> {
    try {
      // Check prerequisites
      this.checkPodman();
      this.setupReportsDirectory();

      // Check and manage container images
      if (!this.config.quiet) {
        console.log('Security Audit Starting...');
      }
      await this.manageContainerImages();

      // Run container scans in parallel
      const promises: Promise<void>[] = [];

      if (!this.config.skipTrivy) {
        promises.push(this.runTrivyContainer());
      } else {
        this.results.summary.tools.trivy.skipped = true;
      }

      if (!this.config.skipSemgrep) {
        promises.push(this.runSemgrepContainer());
      } else {
        this.results.summary.tools.semgrep.skipped = true;
      }

      await Promise.allSettled(promises);

      // Generate report
      this.generateReport();

      // Exit with appropriate code
      this.exit();
    } catch (error) {
      console.error('Security audit failed:', (error as Error).message);
      process.exit(1);
    }
  }

  private checkPodman(): void {
    try {
      execSync('podman --version', { stdio: 'pipe' });
    } catch {
      throw new Error(
        'Podman is not installed or not in PATH.\n' +
          'Please install Podman:\n' +
          '  • macOS: brew install podman\n' +
          '  • Linux: https://podman.io/getting-started/installation\n' +
          '  • Windows: https://github.com/containers/podman/blob/main/docs/tutorials/podman-for-windows.md'
      );
    }
  }

  private setupReportsDirectory(): void {
    if (!existsSync(this.reportsDir)) {
      mkdirSync(this.reportsDir, { recursive: true });
    }
  }

  private async manageContainerImages(): Promise<void> {
    if (!this.config.quiet) {
      console.log('Checking container images...');
    }

    const imageStatus = await this.checkImageStatus();

    // Display status
    this.displayImageStatus(imageStatus);

    // Handle check-only mode
    if (this.config.checkOnly) {
      if (!this.config.quiet) {
        console.log('\nImage status check complete.');
      }
      process.exit(0);
    }

    // Handle updates if needed
    if (imageStatus.hasUpdates && !this.config.quiet) {
      const shouldUpdate = await this.promptForUpdates(imageStatus);
      if (shouldUpdate) {
        await this.updateImages(imageStatus);
      }
    } else if (imageStatus.needsSetup) {
      const shouldSetup = await this.promptForInitialSetup(imageStatus);
      if (shouldSetup) {
        await this.downloadImages(imageStatus);
      } else if (!this.config.offline) {
        throw new Error('Container images are required for security scanning');
      }
    }

    if (!this.config.quiet) {
      console.log('');
    }
  }

  private async checkImageStatus(): Promise<ImageCheckResult> {
    const [trivyStatus, semgrepStatus] = await Promise.all([
      this.checkSingleImageStatus(this.images.trivy),
      this.checkSingleImageStatus(this.images.semgrep),
    ]);

    return {
      trivy: trivyStatus,
      semgrep: semgrepStatus,
      hasUpdates: trivyStatus.hasUpdate || semgrepStatus.hasUpdate,
      needsSetup: !trivyStatus.isAvailable || !semgrepStatus.isAvailable,
    };
  }

  private async checkSingleImageStatus(image: ContainerImage): Promise<ImageStatus> {
    try {
      // Check if image exists locally
      const localDigest = await this.getLocalImageDigest(image.fullName);
      const isAvailable = !!localDigest;

      // Get version and age information for available images
      let version: string | undefined;
      let age: string | undefined;
      if (isAvailable) {
        [version, age] = await Promise.all([
          this.getImageVersion(image.fullName),
          this.getImageAge(image.fullName),
        ]);
      }

      // Check remote digest for updates (skip if offline mode)
      let remoteDigest: string | undefined;
      let hasUpdate = false;

      // Get remote information (digest, version, age)
      let remoteVersion: string | undefined;
      let remoteAge: string | undefined;
      if (!this.config.offline) {
        try {
          // Show progress for remote checks (can be slow)
          if (!this.config.quiet && isAvailable) {
            process.stdout.write(`  Checking ${image.name} for updates... `);
          }

          const remoteInfo = await this.getRemoteImageInfo(image.fullName);
          remoteDigest = remoteInfo.digest;
          remoteVersion = remoteInfo.version;
          remoteAge = remoteInfo.age;

          if (!this.config.quiet && isAvailable) {
            process.stdout.write('done\n');
          }

          hasUpdate = isAvailable && localDigest !== remoteDigest;
          if (this.config.updateImages) {
            hasUpdate = hasUpdate || isAvailable; // Force update if requested
          }
        } catch (error) {
          // Network error or registry unavailable
          if (!this.config.quiet && isAvailable) {
            process.stdout.write('failed\n');
          }
          hasUpdate = false;
        }
      }

      return {
        image,
        isAvailable,
        hasUpdate,
        localDigest,
        remoteDigest,
        needsDownload: !isAvailable || hasUpdate,
        version,
        age,
        remoteVersion,
        remoteAge,
      };
    } catch {
      return {
        image,
        isAvailable: false,
        hasUpdate: false,
        needsDownload: true,
      };
    }
  }

  private async getLocalImageDigest(imageName: string): Promise<string | undefined> {
    try {
      // Validate image name to prevent command injection
      if (!this.isValidImageName(imageName)) {
        throw new Error(`Invalid image name: ${imageName}`);
      }

      // Safe: imageName is validated against allowlist in isValidImageName() and properly quoted
      // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
      const output = execSync(`podman inspect "${imageName}" --format "{{.Digest}}"`, {
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 5000, // 5 second timeout for local operations
      });

      const digest = output.trim();

      // Validate digest format (should start with sha256: and be 64 hex chars)
      if (digest && digest.match(/^sha256:[a-f0-9]{64}$/)) {
        return digest;
      }

      // If digest format is invalid, try alternative method with JSON output
      const jsonOutput = execSync(`podman inspect "${imageName}"`, {
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 5000,
      });

      const imageInfo = JSON.parse(jsonOutput);
      if (imageInfo && imageInfo[0]?.Digest) {
        return imageInfo[0].Digest;
      }

      return undefined;
    } catch (error) {
      // Log specific error types for debugging but still return undefined
      if (this.config.verbose) {
        console.warn(`Failed to get local digest for ${imageName}: ${(error as Error).message}`);
      }
      return undefined;
    }
  }

  private async getRemoteImageInfo(
    imageName: string
  ): Promise<{ digest: string; version?: string; age?: string }> {
    // Validate image name to prevent command injection
    if (!this.isValidImageName(imageName)) {
      throw new Error(`Invalid image name: ${imageName}`);
    }

    // Safe: imageName is validated against allowlist in isValidImageName() and properly quoted
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
    const output = execSync(`podman manifest inspect "${imageName}"`, {
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 10000, // 10 second timeout
    });

    try {
      const manifest = JSON.parse(output.trim());

      // For manifest lists, get the digest of the first amd64/linux manifest
      let digest: string | undefined;
      if (manifest.manifests && Array.isArray(manifest.manifests)) {
        const amd64Manifest = manifest.manifests.find(
          (m: any) => m.platform?.architecture === 'amd64' && m.platform?.os === 'linux'
        );
        if (amd64Manifest?.digest) {
          digest = amd64Manifest.digest;
        }
        // Fallback to first manifest if no amd64/linux found
        else if (manifest.manifests[0]?.digest) {
          digest = manifest.manifests[0].digest;
        }
      }

      // For single image manifests, use the config digest or fall back to a computed digest
      if (!digest && manifest.config?.digest) {
        digest = manifest.config.digest;
      }

      if (!digest) {
        throw new Error('No digest found in manifest');
      }

      // Try to get remote version and age information in parallel
      // Note: This may pull remote images which can be slow
      const [remoteVersion, remoteAge] = await Promise.all([
        this.getRemoteImageVersion(imageName).catch(() => undefined),
        this.getRemoteImageAge(imageName).catch(() => undefined),
      ]);

      return {
        digest,
        version: remoteVersion,
        age: remoteAge,
      };
    } catch (parseError) {
      throw new Error(`Failed to parse manifest JSON: ${(parseError as Error).message}`);
    }
  }

  private async getImageVersion(imageName: string): Promise<string | undefined> {
    try {
      if (!this.isValidImageName(imageName)) {
        return undefined;
      }

      // First try to get version from image labels
      const output = execSync(`podman inspect "${imageName}" --format "{{.Config.Labels}}"`, {
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 5000,
      });

      // Parse the labels map output (Go template format)
      const labelsMatch = output.match(/org\.opencontainers\.image\.version:([^\s}\]]+)/);
      if (labelsMatch && labelsMatch[1] && labelsMatch[1] !== 'develop') {
        return labelsMatch[1];
      }

      // Fallback: try running the container to get version
      // This is slower but more reliable for some images
      try {
        let versionOutput: string;
        if (imageName.includes('trivy')) {
          versionOutput = execSync(`podman run --rm "${imageName}" --version`, {
            stdio: 'pipe',
            encoding: 'utf-8',
            timeout: 10000,
          });
          const versionMatch = versionOutput.match(/Version:\s*([^\s\n]+)/);
          return versionMatch ? versionMatch[1] : undefined;
        } else if (imageName.includes('semgrep')) {
          versionOutput = execSync(`podman run --rm "${imageName}" semgrep --version`, {
            stdio: 'pipe',
            encoding: 'utf-8',
            timeout: 10000,
          });
          const semgrepVersion = versionOutput.trim().split('\n')[0];
          return semgrepVersion && semgrepVersion !== 'develop' ? semgrepVersion : undefined;
        }
      } catch {
        // Fallback failed, return undefined
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  private async getImageAge(imageName: string): Promise<string | undefined> {
    try {
      if (!this.isValidImageName(imageName)) {
        return undefined;
      }

      const output = execSync(`podman inspect "${imageName}" --format "{{.Created}}"`, {
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 5000,
      });

      const createdDate = new Date(output.trim());
      if (isNaN(createdDate.getTime())) {
        return undefined;
      }

      const now = new Date();
      const ageMs = now.getTime() - createdDate.getTime();
      const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

      if (ageDays < 1) {
        return 'today';
      } else if (ageDays < 7) {
        return ageDays === 1 ? '1 day old' : `${ageDays} days old`;
      } else if (ageDays < 30) {
        const weeks = Math.floor(ageDays / 7);
        return weeks === 1 ? '1 week old' : `${weeks} weeks old`;
      } else if (ageDays < 365) {
        const months = Math.floor(ageDays / 30);
        return months === 1 ? '1 month old' : `${months} months old`;
      } else {
        const years = Math.floor(ageDays / 365);
        return years === 1 ? '1 year old' : `${years} years old`;
      }
    } catch {
      return undefined;
    }
  }

  private async getRemoteImageVersion(imageName: string): Promise<string | undefined> {
    try {
      if (!this.isValidImageName(imageName)) {
        return undefined;
      }

      // Run the remote container directly to get version info
      // This may pull the latest version if not cached locally
      let versionOutput: string;
      if (imageName.includes('trivy')) {
        versionOutput = execSync(`podman run --rm "${imageName}" --version`, {
          stdio: 'pipe',
          encoding: 'utf-8',
          timeout: 20000,
        });
        const versionMatch = versionOutput.match(/Version:\s*([^\s\n]+)/);
        return versionMatch ? versionMatch[1] : undefined;
      } else if (imageName.includes('semgrep')) {
        versionOutput = execSync(`podman run --rm "${imageName}" semgrep --version`, {
          stdio: 'pipe',
          encoding: 'utf-8',
          timeout: 20000,
        });
        const semgrepVersion = versionOutput.trim().split('\n')[0];
        return semgrepVersion && semgrepVersion !== 'develop' ? semgrepVersion : undefined;
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  private async getRemoteImageAge(imageName: string): Promise<string | undefined> {
    try {
      if (!this.isValidImageName(imageName)) {
        return undefined;
      }

      // Get creation date from remote image by inspecting it
      // This will use cached remote image if available from version check
      const output = execSync(`podman inspect "${imageName}" --format "{{.Created}}"`, {
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 10000, // Should be fast if image is already pulled
      });

      const createdDate = new Date(output.trim());
      if (isNaN(createdDate.getTime())) {
        return undefined;
      }

      const now = new Date();
      const ageMs = now.getTime() - createdDate.getTime();
      const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

      if (ageDays < 1) {
        return 'today';
      } else if (ageDays < 7) {
        return ageDays === 1 ? '1 day old' : `${ageDays} days old`;
      } else if (ageDays < 30) {
        const weeks = Math.floor(ageDays / 7);
        return weeks === 1 ? '1 week old' : `${weeks} weeks old`;
      } else if (ageDays < 365) {
        const months = Math.floor(ageDays / 30);
        return months === 1 ? '1 month old' : `${months} months old`;
      } else {
        const years = Math.floor(ageDays / 365);
        return years === 1 ? '1 year old' : `${years} years old`;
      }
    } catch {
      return undefined;
    }
  }

  private isValidImageName(imageName: string): boolean {
    // Only allow known safe image names to prevent command injection
    const allowedImages = [this.images.trivy.fullName, this.images.semgrep.fullName];
    return allowedImages.includes(imageName);
  }

  private displayImageStatus(status: ImageCheckResult): void {
    if (this.config.quiet) return;

    // Helper function to determine status symbol, size display, and message
    const getImageDisplay = (imageStatus: ImageStatus) => {
      const versionText = imageStatus.version ? ` v${imageStatus.version}` : '';
      const ageText = imageStatus.age ? `, ${imageStatus.age}` : '';

      if (!imageStatus.isAvailable) {
        // Image not found locally but can be downloaded
        return {
          symbol: '[!]',
          sizeDisplay: `${imageStatus.image.estimatedSize} to download`,
          text: 'not found, needs download',
        };
      }

      if (!imageStatus.remoteDigest) {
        // Registry check failed, using cached version - this is an error condition
        return {
          symbol: '[ERROR]',
          sizeDisplay: `${imageStatus.image.estimatedSize} cached${ageText}`,
          text: 'Registry check failed, using cached version',
        };
      }

      if (imageStatus.hasUpdate) {
        // New version available - action recommended
        // Show both current cached size and download size for full system visibility
        const remoteAgeText = imageStatus.remoteAge ? `, ${imageStatus.remoteAge}` : '';

        // Show remote version information with context
        let updateText: string;
        if (imageStatus.remoteVersion) {
          if (imageStatus.version && imageStatus.version === imageStatus.remoteVersion) {
            updateText = `v${imageStatus.remoteVersion} available (updated build)`;
          } else {
            updateText = `v${imageStatus.remoteVersion} available`;
          }
        } else {
          updateText = 'new version available';
        }

        return {
          symbol: '[!]',
          sizeDisplay: `${imageStatus.image.estimatedSize} cached${ageText}`,
          text: `${updateText} (${imageStatus.image.estimatedSize} to download${remoteAgeText})`,
        };
      }

      // Everything up to date
      return {
        symbol: '[OK]',
        sizeDisplay: `${imageStatus.image.estimatedSize} cached${ageText}`,
        text: 'verified up to date',
      };
    };

    const trivyDisplay = getImageDisplay(status.trivy);
    const semgrepDisplay = getImageDisplay(status.semgrep);

    const trivyVersionText = status.trivy.version ? ` v${status.trivy.version}` : '';
    const semgrepVersionText = status.semgrep.version ? ` v${status.semgrep.version}` : '';

    console.log(
      `  ${trivyDisplay.symbol} Trivy${trivyVersionText} (${trivyDisplay.sizeDisplay}): ${trivyDisplay.text}`
    );
    console.log(
      `  ${semgrepDisplay.symbol} Semgrep${semgrepVersionText} (${semgrepDisplay.sizeDisplay}): ${semgrepDisplay.text}`
    );

    // Show digests if requested
    if (this.config.showDigests) {
      if (status.trivy.localDigest) {
        console.log(`    Local digest:  ${status.trivy.localDigest.substring(0, 16)}...`);
      }
      if (status.trivy.remoteDigest && status.trivy.remoteDigest !== status.trivy.localDigest) {
        console.log(`    Remote digest: ${status.trivy.remoteDigest.substring(0, 16)}...`);
      }
      if (status.semgrep.localDigest) {
        console.log(`    Local digest:  ${status.semgrep.localDigest.substring(0, 16)}...`);
      }
      if (
        status.semgrep.remoteDigest &&
        status.semgrep.remoteDigest !== status.semgrep.localDigest
      ) {
        console.log(`    Remote digest: ${status.semgrep.remoteDigest.substring(0, 16)}...`);
      }
    }
  }

  private async promptForUpdates(status: ImageCheckResult): Promise<boolean> {
    if (this.config.assumeYes || this.config.checkOnly) return !this.config.checkOnly;

    const updates: string[] = [];
    if (status.trivy.hasUpdate) updates.push(`Trivy (${status.trivy.image.estimatedSize})`);
    if (status.semgrep.hasUpdate) updates.push(`Semgrep (${status.semgrep.image.estimatedSize})`);

    if (updates.length === 0) return false;

    const updateList = updates.length === 1 ? updates[0] : updates.join(', ');
    const question = `\nDownload ${updateList} update? [Y/n] `;

    return this.promptUser(question);
  }

  private async promptForInitialSetup(status: ImageCheckResult): Promise<boolean> {
    if (this.config.assumeYes) return true;
    if (this.config.checkOnly) return false;

    const needed: string[] = [];
    if (!status.trivy.isAvailable) needed.push(`Trivy (${status.trivy.image.estimatedSize})`);
    if (!status.semgrep.isAvailable) needed.push(`Semgrep (${status.semgrep.image.estimatedSize})`);

    if (needed.length === 0) return true;

    console.log('\nSetting up security scanning tools...');
    console.log('\nThis tool requires container images for scanning:');
    needed.forEach(tool => console.log(`  - ${tool}`));
    console.log('\nImages will be cached locally for future use.');

    return this.promptUser('Download now? [Y/n] ');
  }

  private promptUser(question: string): Promise<boolean> {
    return new Promise(resolve => {
      process.stdout.write(question);
      process.stdin.once('data', data => {
        const answer = data.toString().trim().toLowerCase();
        resolve(answer === '' || answer === 'y' || answer === 'yes');
      });
    });
  }

  private async updateImages(status: ImageCheckResult): Promise<void> {
    if (status.trivy.hasUpdate) {
      await this.downloadSingleImage(status.trivy.image);
    }
    if (status.semgrep.hasUpdate) {
      await this.downloadSingleImage(status.semgrep.image);
    }
  }

  private async downloadImages(status: ImageCheckResult): Promise<void> {
    if (!status.trivy.isAvailable) {
      await this.downloadSingleImage(status.trivy.image);
    }
    if (!status.semgrep.isAvailable) {
      await this.downloadSingleImage(status.semgrep.image);
    }
  }

  private async downloadSingleImage(image: ContainerImage): Promise<void> {
    if (!this.config.quiet) {
      process.stdout.write(`  ⬇ ${image.name}: downloading... `);
    }

    try {
      // Safe: image.fullName comes from hardcoded ContainerImage objects and is properly quoted
      // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
      execSync(`podman pull "${image.fullName}"`, {
        stdio: this.config.quiet ? 'pipe' : 'pipe',
        timeout: this.config.containerTimeout * 1000,
      });

      if (!this.config.quiet) {
        console.log(`✓ (${image.estimatedSize})`);
      }
    } catch (error) {
      if (!this.config.quiet) {
        console.log('✗ failed');
      }
      throw new Error(`Failed to download ${image.name}: ${(error as Error).message}`);
    }
  }

  private async runTrivyContainer(): Promise<void> {
    if (!this.config.quiet) {
      process.stdout.write('Scanning dependencies... ');
    }

    try {
      const outputFile = join(this.reportsDir, `trivy-${Date.now()}.json`);

      // Run Trivy scan
      execSync(
        `podman run --rm ` +
          `-v "${process.cwd()}:/workspace:ro" ` +
          `-v "${this.reportsDir}:/reports:rw" ` +
          `--workdir /workspace ` +
          `${this.images.trivy.fullName} ` +
          `fs --format json --output /reports/${relative(this.reportsDir, outputFile).replace(/\\/g, '/')} ` +
          `--timeout ${this.config.containerTimeout}s ` +
          `/workspace`,
        {
          stdio: 'pipe',
          timeout: (this.config.containerTimeout + 60) * 1000,
        }
      );

      // Parse results
      if (existsSync(outputFile)) {
        const trivyOutput = JSON.parse(readFileSync(outputFile, 'utf-8'));
        this.processTrivyResults(trivyOutput);
        unlinkSync(outputFile); // Cleanup
      }

      this.results.summary.tools.trivy.success = true;

      if (!this.config.quiet) {
        console.log(`done (${this.results.summary.tools.trivy.issues} issues)`);
      }
    } catch (error) {
      this.results.trivy.errors.push(`Container scan failed: ${(error as Error).message}`);
      if (!this.config.quiet) {
        console.log('failed');
      }
    }
  }

  private async runSemgrepContainer(): Promise<void> {
    if (!this.config.quiet) {
      process.stdout.write('Analyzing code security... ');
    }

    try {
      const outputFile = join(this.reportsDir, `semgrep-${Date.now()}.json`);

      // Run Semgrep scan
      execSync(
        `podman run --rm ` +
          `-v "${process.cwd()}:/workspace:ro" ` +
          `-v "${this.reportsDir}:/reports:rw" ` +
          `--workdir /workspace ` +
          `${this.images.semgrep.fullName} ` +
          `semgrep scan ` +
          `--config ${this.config.semgrepConfig} ` +
          `--json ` +
          `--output /reports/${relative(this.reportsDir, outputFile).replace(/\\/g, '/')} ` +
          `--timeout ${this.config.containerTimeout} ` +
          `/workspace`,
        {
          stdio: 'pipe',
          timeout: (this.config.containerTimeout + 60) * 1000,
        }
      );

      // Parse results
      if (existsSync(outputFile)) {
        const semgrepOutput = JSON.parse(readFileSync(outputFile, 'utf-8'));
        this.processSemgrepResults(semgrepOutput);
        unlinkSync(outputFile); // Cleanup
      }

      this.results.summary.tools.semgrep.success = true;

      if (!this.config.quiet) {
        console.log(`done (${this.results.summary.tools.semgrep.issues} issues)`);
      }
    } catch (error) {
      this.results.semgrep.errors.push(`Container scan failed: ${(error as Error).message}`);
      if (!this.config.quiet) {
        console.log('failed');
      }
    }
  }

  private processTrivyResults(trivyData: TrivyReport): void {
    if (!trivyData.Results) return;

    for (const result of trivyData.Results) {
      if (result.Vulnerabilities) {
        for (const vuln of result.Vulnerabilities) {
          const severity = this.normalizeSeverity(vuln.Severity);
          const packagePath = result.Target || 'dependencies';

          this.results.trivy.vulnerabilities.push({
            id: vuln.VulnerabilityID,
            package: vuln.PkgName,
            version: vuln.InstalledVersion,
            fixedVersion: vuln.FixedVersion,
            severity,
            title: vuln.Title,
            description: vuln.Description,
            references: vuln.References || [],
            cvss: vuln.CVSS,
            path: packagePath,
          });

          this.results.summary.tools.trivy.issues++;
          this.results.summary.totalIssues++;
          this.results.summary[
            severity as keyof Pick<Summary, 'critical' | 'high' | 'medium' | 'low'>
          ]++;
        }
      }
    }
  }

  private processSemgrepResults(semgrepData: SemgrepReport): void {
    if (!semgrepData.results) return;

    for (const finding of semgrepData.results) {
      const severity = this.normalizeSeverity(finding.extra?.severity || 'medium');

      this.results.semgrep.findings.push({
        ruleId: finding.check_id,
        message: finding.extra?.message || finding.check_id,
        severity,
        file: finding.path.replace(/^.*\/workspace\//, ''),
        line: finding.start?.line,
        column: finding.start?.col,
        endLine: finding.end?.line,
        endColumn: finding.end?.col,
        confidence: finding.extra?.metadata?.confidence,
        owasp: finding.extra?.metadata?.owasp,
        cwe: finding.extra?.metadata?.cwe,
        fix: finding.extra?.fix,
      });

      this.results.summary.tools.semgrep.issues++;
      this.results.summary.totalIssues++;
      this.results.summary[
        severity as keyof Pick<Summary, 'critical' | 'high' | 'medium' | 'low'>
      ]++;
    }

    if (semgrepData.errors) {
      this.results.semgrep.errors.push(
        ...semgrepData.errors.map((e: SemgrepError) => e.message || String(e))
      );
    }
  }

  private normalizeSeverity(severity: string | undefined): string {
    if (!severity) return 'medium';

    const normalized = severity.toLowerCase();
    const mapping: Record<string, string> = {
      critical: 'critical',
      high: 'high',
      medium: 'medium',
      moderate: 'medium',
      low: 'low',
      info: 'low',
      warning: 'medium',
      error: 'high',
    };

    return mapping[normalized] || 'medium';
  }

  private generateReport(): void {
    if (this.config.json || this.config.output) {
      const jsonReport = JSON.stringify(this.results, null, 2);

      if (this.config.output) {
        writeFileSync(this.config.output, jsonReport);
        if (!this.config.quiet) {
          console.log(`\nReport saved to ${this.config.output}`);
        }
      } else {
        console.log(jsonReport);
      }
    } else {
      this.printLinterStyleReport();
    }
  }

  private printLinterStyleReport(): void {
    const { trivy, semgrep } = this.results;
    const hasIssues = this.results.summary.totalIssues > 0;

    // Print vulnerabilities in linter style
    if (trivy.vulnerabilities.length > 0) {
      trivy.vulnerabilities
        .sort((a, b) => this.severityWeight(b.severity) - this.severityWeight(a.severity))
        .forEach(vuln => {
          const severityColor = this.getSeverityColor(vuln.severity);
          const path = vuln.path === 'dependencies' ? vuln.package : `${vuln.path}:${vuln.package}`;

          console.log(
            `${path}: ${severityColor}${vuln.severity}${this.resetColor()} ${vuln.title} (${vuln.id})`
          );

          if (vuln.fixedVersion) {
            console.log(`  Fix available: ${vuln.version} → ${vuln.fixedVersion}`);
          } else {
            console.log(`  Current version: ${vuln.version} (no fix available)`);
          }

          if (vuln.description && vuln.description !== vuln.title) {
            console.log(`  ${this.wrapText(vuln.description, 80, '  ')}`);
          }

          if (vuln.references && vuln.references.length > 0) {
            console.log(`  More info: ${vuln.references[0]}`);
          }

          console.log('');
        });
    }

    if (semgrep.findings.length > 0) {
      semgrep.findings
        .sort((a, b) => this.severityWeight(b.severity) - this.severityWeight(a.severity))
        .forEach(finding => {
          const severityColor = this.getSeverityColor(finding.severity);
          const location = `${finding.file}:${finding.line}:${finding.column}`;

          console.log(
            `${location}: ${severityColor}${finding.severity}${this.resetColor()} ${finding.message}`
          );

          if (finding.ruleId) {
            console.log(`  Rule: ${finding.ruleId}`);
          }

          if (finding.cwe) {
            console.log(`  CWE: ${finding.cwe.join(', ')}`);
          }

          if (finding.owasp) {
            console.log(`  OWASP: ${finding.owasp.join(', ')}`);
          }

          if (finding.fix) {
            console.log(`  Suggested fix: ${finding.fix}`);
          }

          console.log('');
        });
    }

    // Print summary
    if (hasIssues) {
      const summary = this.results.summary;
      const parts: string[] = [];

      if (summary.critical > 0) parts.push(`${summary.critical} critical`);
      if (summary.high > 0) parts.push(`${summary.high} high`);
      if (summary.medium > 0) parts.push(`${summary.medium} medium`);
      if (summary.low > 0) parts.push(`${summary.low} low`);

      console.log(`Found ${summary.totalIssues} security issues (${parts.join(', ')})`);
    } else {
      console.log('No security issues found');
    }

    // Print tool errors if any
    if (trivy.errors.length > 0 || semgrep.errors.length > 0) {
      console.log('\nWarnings:');
      [...trivy.errors, ...semgrep.errors].forEach(error => {
        console.log(`  ${error}`);
      });
    }
  }

  private getSeverityColor(severity: string): string {
    if (process.stdout.isTTY) {
      const colors: Record<string, string> = {
        critical: '\x1b[91m', // bright red
        high: '\x1b[31m', // red
        medium: '\x1b[33m', // yellow
        low: '\x1b[36m', // cyan
      };
      return colors[severity] || '';
    }
    return '';
  }

  private resetColor(): string {
    return process.stdout.isTTY ? '\x1b[0m' : '';
  }

  private wrapText(text: string, width: number, prefix: string = ''): string {
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = prefix;

    for (const word of words) {
      if (currentLine.length + word.length + 1 <= width) {
        currentLine += (currentLine === prefix ? '' : ' ') + word;
      } else {
        lines.push(currentLine);
        currentLine = prefix + word;
      }
    }

    if (currentLine.length > prefix.length) {
      lines.push(currentLine);
    }

    return lines.join('\n');
  }

  private severityWeight(severity: string): number {
    const weights: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
    return weights[severity] || 0;
  }

  private shouldFail(): boolean {
    if (!this.config.ci) return false;

    const severityLevels = ['low', 'medium', 'high', 'critical'];
    const minIndex = severityLevels.indexOf(this.config.severity);

    for (let i = minIndex; i < severityLevels.length; i++) {
      if (
        this.results.summary[
          severityLevels[i] as keyof Pick<Summary, 'low' | 'medium' | 'high' | 'critical'>
        ] > 0
      ) {
        return true;
      }
    }

    return false;
  }

  private exit(): void {
    if (this.shouldFail()) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  }
}

// Run the auditor
const auditor = new SecurityAuditor();
auditor.run().catch(error => {
  console.error('Security audit failed:', error.message);
  process.exit(1);
});
