/**
 * SBOM Command
 *
 * Displays the embedded Software Bill of Materials (SBOM) for supply chain
 * transparency. Supports SPDX 3.0 System Package Data Exchange.
 */

import { Command, Flags } from '@oclif/core';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface SbomInfo {
  version: string;
  format: 'SPDX-3.0';
  standard: 'System Package Data Exchange';
  organization: string;
  program: string;
  generated: string;
  totalElements: number;
  securityVulnerabilities: number;
  securityFindings: number;
}

export default class Sbom extends Command {
  static override description = 'Display Software Bill of Materials (SBOM)';

  static override summary = 'Show embedded SPDX 3.0 SBOM for transparency';

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --format yaml',
    '<%= config.bin %> <%= command.id %> --format json --no-color',
    '<%= config.bin %> <%= command.id %> --info --verbose',
  ];

  static override flags = {
    format: Flags.string({
      char: 'f',
      description: 'Output format for SBOM data',
      options: ['info', 'yaml', 'json', 'raw'],
      default: 'info',
    }),
    verbose: Flags.boolean({
      char: 'V',
      description: 'Enable verbose output with detailed information',
      default: false,
    }),
    'no-color': Flags.boolean({
      description: 'Disable colored output',
      default: false,
    }),
    info: Flags.boolean({
      char: 'i',
      description: 'Show SBOM metadata and summary information only',
      default: false,
    }),
    verify: Flags.boolean({
      description: 'Verify SBOM integrity and format',
      default: false,
    }),
  };

  private getEmbeddedSbom(): string | null {
    // Try to find embedded SBOM in multiple locations
    const possiblePaths = [
      // Embedded during build process
      join(process.cwd(), 'dist', 'sbom', `archifiltre-5.0.0-alpha.3.spdx3.yaml`),
      join(process.cwd(), 'archifiltre.sbom'),
      // Development paths
      join(__dirname, '..', '..', '..', 'dist', 'sbom', `archifiltre-5.0.0-alpha.3.spdx3.yaml`),
    ];

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        try {
          return readFileSync(path, 'utf-8');
        } catch {
          continue;
        }
      }
    }

    return null;
  }

  private parseSbomInfo(sbomContent: string): SbomInfo {
    try {
      // Parse YAML content to extract metadata
      const lines = sbomContent.split('\n');
      const info: Partial<SbomInfo> = {
        format: 'SPDX-3.0',
        standard: 'System Package Data Exchange',
        organization: 'République française – Ministère de la Culture (SNUM/SIAF)',
        program: 'Vitam (Programme interministériel)',
      };

      // Extract version
      const versionLine = lines.find(l => l.includes('spdx_version:'));
      info.version = versionLine ? versionLine.split(':')[1]?.trim() || '3.0.1' : '3.0.1';

      // Extract generated date
      const generatedLine = lines.find(l => l.includes('# Generated on:'));
      info.generated = generatedLine
        ? generatedLine.replace('# Generated on:', '').trim()
        : new Date().toISOString();

      // Extract element count
      const elementsSection = sbomContent.match(/elements:\s*\n([\s\S]*?)(?:\n\S|$)/);
      const elementCount = elementsSection
        ? (sbomContent.match(/https:\/\/www\.archifiltre\.org/g) || []).length
        : 0;
      info.totalElements = elementCount;

      // Extract security data
      const securityMatch = sbomContent.match(/total_vulnerabilities:\s*(\d+)/);
      info.securityVulnerabilities = securityMatch ? parseInt(securityMatch[1], 10) : 0;

      const findingsMatch = sbomContent.match(/total_findings:\s*(\d+)/);
      info.securityFindings = findingsMatch ? parseInt(findingsMatch[1], 10) : 0;

      return info as SbomInfo;
    } catch (error) {
      throw new Error(
        `Failed to parse SBOM metadata: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private formatSbomInfo(info: SbomInfo, verbose: boolean): string {
    let output = '';

    output += `Archifiltre Software Bill of Materials (SBOM)\n`;
    output += `============================================\n\n`;

    output += `Format: ${info.format} (${info.standard})\n`;
    output += `Version: ${info.version}\n`;
    output += `Generated: ${info.generated}\n`;
    output += `Total Elements: ${info.totalElements}\n\n`;

    output += `Organization:\n`;
    output += `  ${info.organization}\n`;
    output += `  Program: ${info.program}\n\n`;

    output += `Security Analysis:\n`;
    output += `  Vulnerabilities: ${info.securityVulnerabilities}\n`;
    output += `  Security Findings: ${info.securityFindings}\n\n`;

    if (verbose) {
      output += `\nAdditional Information:\n`;
      output += `  License: Apache-2.0\n`;
      output += `  Contact: archifiltre@culture.gouv.fr\n`;
      output += `  Website: https://www.archifiltre.org\n`;
      output += `  Program: https://www.programmevitam.fr/\n\n`;

      output += `SPDX 3.0 Features:\n`;
      output += `  ✓ Element-based architecture\n`;
      output += `  ✓ Enhanced relationship modeling\n`;
      output += `  ✓ Security vulnerability integration\n`;
      output += `  ✓ Software purpose classification\n`;
      output += `  ✓ Extended metadata support\n`;
    }

    return output;
  }

  private verifySbom(sbomContent: string): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    // Basic SPDX 3.0 validation
    if (!sbomContent.includes('spdx_version: 3.0.1')) {
      issues.push('Missing or invalid SPDX version');
    }

    if (!sbomContent.includes('data_license: CC0-1.0')) {
      issues.push('Missing or invalid data license');
    }

    if (!sbomContent.includes('République française')) {
      issues.push('Missing French government attribution');
    }

    if (!sbomContent.includes('elements:')) {
      issues.push('Missing SPDX elements section');
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(Sbom);

    try {
      if (flags.verbose) {
        this.log('[VERBOSE] Retrieving embedded SBOM...');
      }

      const sbomContent = this.getEmbeddedSbom();

      if (!sbomContent) {
        this.error(
          'SBOM not found. The Software Bill of Materials should be embedded during the build process.\n' +
            'Try running: bun run build:cli',
          { exit: 1 }
        );
      }

      // Verify SBOM if requested
      if (flags.verify) {
        const verification = this.verifySbom(sbomContent);
        if (!verification.valid) {
          this.error(
            `SBOM verification failed:\n${verification.issues.map(i => `  - ${i}`).join('\n')}`,
            { exit: 1 }
          );
        }
        this.log('SBOM verification passed');
      }

      // Handle different output formats
      switch (flags.format) {
        case 'raw':
          this.log(sbomContent);
          break;

        case 'yaml': {
          // Remove comments and output clean YAML
          const cleanYaml = sbomContent
            .split('\n')
            .filter(line => !line.trim().startsWith('#'))
            .join('\n');
          this.log(cleanYaml);
          break;
        }

        case 'json': {
          try {
            // Convert YAML to JSON (simplified)
            const info = this.parseSbomInfo(sbomContent);
            this.log(JSON.stringify(info, null, 2));
          } catch (error) {
            this.error(
              `Failed to convert SBOM to JSON: ${error instanceof Error ? error.message : 'Unknown error'}`,
              { exit: 1 }
            );
          }
          break;
        }

        case 'info':
        default: {
          const info = this.parseSbomInfo(sbomContent);
          const formatted = this.formatSbomInfo(info, flags.verbose || flags.info);
          this.log(formatted);
          break;
        }
      }

      if (flags.verbose) {
        this.log(`[VERBOSE] SBOM displayed successfully (${sbomContent.length} characters)`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.error(`Failed to retrieve SBOM: ${message}`, { exit: 1 });
    }
  }
}
