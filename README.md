# Archifiltre v5

**Privacy-first file scanning tool for complete directory analysis and duplicate detection.**

---

**Official Project of the French Republic**

- **Organization**: République française – Ministère de la Culture (SNUM/SIAF)  
- **Program**: Programme interministériel Vitam
- **Contact**: archifiltre@culture.gouv.fr
- **Website**: https://www.archifiltre.org

---

Archifiltre analyzes file systems locally with comprehensive scanning capabilities. Get complete insights into your directories with professional reporting and intelligent duplicate detection.

## Features

- **Complete directory scanning** - catalogs all files and folders with metadata
- **Duplicate detection** - identifies potential duplicates by file size analysis  
- **Professional reporting** - clean, actionable summaries with key insights
- **Local processing** - runs entirely on your machine with local database storage

## Installation

### Prerequisites

**Install Bun (JavaScript runtime):**

```bash
# Install Bun (macOS/Linux)
curl -fsSL https://bun.sh/install | bash

# Or using npm
npm install -g bun

# Verify installation
bun --version
```

**For Windows:** Visit [bun.sh](https://bun.sh/) for Windows installation instructions.

### Setup from Source

```bash
# Clone the repository
git clone https://github.com/ProgrammeVitam/archifiltre.git
cd archifiltre

# Install dependencies
bun install

# Build the production binary
bun run build:cli

# Verify the build
./archifiltre --version
```

### Development Setup

```bash
# Install dependencies
bun install

# Run in development mode (no build required)
bun run dev --help
```

## Usage

### Primary Commands

#### File Scanning (Main Feature)

```bash
# Scan a directory
./archifiltre scan /path/to/directory

# Example output:
# Scan completed.
#   Files discovered: 1,234
#   Potential duplicates: 45 files in 12 groups
#   Folders: 25
#   Empty folders: 3
#   Hidden files: 8
```

**Scan Options:**
```bash
# Include hidden files (default: false)
./archifiltre scan /path --include-hidden

# Custom batch size for performance
./archifiltre scan /path --batch-size 2000

# Use custom database name
./archifiltre scan /path --db my-custom-scan

# Minimum file size for hash calculation
./archifiltre scan /path --min-size 1024
```

#### System Commands

```bash
# Check system health and requirements
./archifiltre health

# Verbose health check with detailed information
./archifiltre health --verbose

# Show version information
./archifiltre version

# Show help
./archifiltre --help
./archifiltre scan --help  # Command-specific help
```

#### SBOM Generation

```bash
# Generate Software Bill of Materials
./archifiltre sbom

# SBOM with verbose output
./archifiltre sbom --verbose
```

### Development Commands

```bash
# Run in development mode (faster iteration)
bun run dev scan /path/to/test
bun run dev health --verbose

# Build production binary
bun run build:cli

# Run all tests
bun run test

# Run specific test suites
bun run test:unit
bun run test:integration

# Code quality
bun run lint              # Check code quality
bun run lint:fix          # Fix auto-fixable issues
bun run format            # Format code
bun run format:check      # Check formatting

# Type checking
bun run typecheck

# Security auditing
bun run security:audit           # Full security audit
bun run security:audit:quick     # Quick security check
bun run security:audit:ci        # CI-friendly audit
```

### Build and Release

```bash
# Generate SBOM (Software Bill of Materials)
bun run sbom                 # Standard SBOM
bun run sbom:compliance      # Compliance-focused SBOM
bun run sbom:security        # Security-focused SBOM

# Build release package
bun run build:release        # Includes SBOM generation

# Smoke test the built binary
bun run smoke:cli
```

## Configuration

### User Configuration

Create `~/.config/archifiltre/config.toml` for persistent settings:

```toml
[scanning]
includeHidden = true
maxDepth = 15
calculateHashes = true
minSizeForHash = 512
batchSize = 2000

[logging]
level = "debug"
enableFileLogging = true
enableConsoleLogging = true
maxFileSize = "50m"
maxFiles = "7d"

[privacy]
enableAnalytics = false
enableCrashReporting = false
sanitizeFilePaths = true
allowExternalServices = false

[storage]
databaseName = "my-scans"
enableWAL = true
retentionDays = 30
maxDatabaseSize = "1GB"
```

## Understanding Results

### Files Discovered
Total number of files and directories found in the scan.

### Potential Duplicates
Files with identical sizes that may be duplicates. Format: "X files in Y groups"
- **Files**: Total number of potentially duplicate files
- **Groups**: Number of different file sizes with duplicates

*Example: "45 files in 12 groups" means 12 different file sizes have multiple copies, totaling 45 files that could be duplicates.*

### Folders & Empty Folders
- **Folders**: Total directory count
- **Empty folders**: Directories with no content (cleanup opportunities)

### Hidden Files
System and hidden files (starting with `.` on Unix systems).

## Architecture

### Project Structure
```
src/
├── main.ts            # CLI entry point
├── commands/          # CLI command implementations
│   ├── scan.ts       # Main scanning command
│   ├── health.ts     # System health checks
│   └── version.ts    # Version information
├── lib/              # Core functionality  
│   ├── scanner.ts    # File scanning engine
│   ├── database.ts   # Data storage (PGlite)
│   ├── config.ts     # TOML configuration system
│   └── helpers.ts    # Utility functions
└── extensions/       # Analysis extensions
    └── summary.ts    # Summary reporting
```

### Database-Driven Analysis
- **Complete cataloging** - all files stored with metadata
- **Flexible querying** - extensions analyze data independently  
- **PGlite database** - embedded PostgreSQL for rich queries
- **Source of truth** - database contains the complete picture

## Development

### Development Workflow

```bash
# 1. Setup
bun install

# 2. Development iteration
bun run dev scan /test/directory     # Quick testing
bun run lint                         # Check code quality
bun run test                         # Run tests

# 3. Before committing
bun run typecheck                    # Type safety
bun run format                       # Code formatting
bun run security:audit:quick         # Security check

# 4. Build and test
bun run build:cli                    # Production build
bun run smoke:cli                    # Test the binary
```

### Creating Extensions

Extensions analyze the complete file catalog and present custom insights:

```typescript
// src/extensions/my-analysis.ts
import { Command } from '@oclif/core';
import type { DatabaseConnection } from '@lib/database.ts';

export async function myAnalysis(
  database: DatabaseConnection,
  runId: string, 
  cli: Command
): Promise<void> {
  // Query the complete file catalog
  const stats = await getMyCustomStats(database, runId);
  
  // Present custom analysis
  cli.log('My Custom Analysis:');
  cli.log(`  Custom metric: ${stats.myMetric}`);
}
```

### Code Quality Tools

```bash
# Linting and formatting
bun run lint                    # ESLint check
bun run lint:fix               # Auto-fix issues
bun run format                 # Prettier formatting
bun run format:check           # Check formatting

# Security
bun run security:audit         # Full security audit
bun run security:audit:quick   # Quick security scan
bun run security:audit:json    # JSON output for CI

# Type checking
bun run typecheck             # TypeScript type checking
```

## Contributing

### Development Setup
1. Fork the repository
2. Install Bun: `curl -fsSL https://bun.sh/install | bash`
3. Clone your fork: `git clone https://github.com/yourusername/archifiltre.git`
4. Install dependencies: `bun install`
5. Create a feature branch: `git checkout -b feature/your-feature`

### Before Submitting
```bash
# Ensure code quality
bun run lint
bun run typecheck
bun run test
bun run security:audit:quick

# Test the build
bun run build:cli
bun run smoke:cli
```

### Pull Request Process
1. Make your changes
2. Add tests if applicable
3. Update documentation
4. Run the full test suite
5. Submit a pull request with a clear description

## Support

- **Issues**: https://github.com/ProgrammeVitam/archifiltre/issues
- **Email**: archifiltre@culture.gouv.fr
- **Documentation**: https://www.archifiltre.org

---

*Archifiltre v5 - Complete file system analysis for professional environments.*