# Archifiltre v5

**Privacy-friendly, 100% offline desktop tool for inventorying large file trees, detecting duplicates/similarities, and producing exports for cleanup/analysis.**

---

**Official Project of the French Republic**

- **Organization**: République française – Ministère de la Culture (SNUM) / CIAF / DINUM  
- **Program**: Programme interministériel VITAM
- **Contact**: archifiltre@programmevitam.fr
- **Website**: https://archifiltre.fabrique.social.gouv.fr

---

Archifiltre runs **entirely on your machine** with no telemetry, no servers, and no network dependencies.

## What's New in v5?

Archifiltre v5 is a complete rebuild focused on **speed, reliability, and modularity**:

- **Single binary** distribution via Bun compile
- **CLI-first** architecture with internal API
- **Crash-safe** operations with pause/resume
- **Reproducible builds** and robust CI/CD
- **100% offline** - no network dependencies

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0
- [Podman](https://podman.io/) (for security scanning in development)

### Installation

```bash
# Clone the repository
git clone https://github.com/ProgrammeVitam/archifiltre.git
cd archifiltre

# Install dependencies
bun install

# Build the CLI binary
bun run build:cli

# Run smoke tests
bun run smoke:cli
```

### Usage

```bash
# Show help
./archifiltre --help

# Show version
./archifiltre --version

# Check system health
./archifiltre health

# Enable verbose logging
./archifiltre --verbose health

# Generate Software Bill of Materials (SBOM)
bun run sbom

# Generate compliance-focused SBOM
bun run sbom:compliance

# Generate security-focused SBOM with vulnerabilities
bun run sbom:security
```

## SBOM Generation

Archifiltre includes comprehensive Software Bill of Materials (SBOM) generation capabilities for compliance and security requirements. **SBOM generation is a development/build-time tool** that analyzes the software to produce compliance documentation.

### Supported Formats

- **SPDX 2.3** (JSON/YAML) - ISO standard for compliance
- **CycloneDX 1.5** (JSON/XML) - OWASP standard for security

### Quick Examples

```bash
# Generate compliance SBOM (SPDX format)
bun run sbom:compliance

# Generate security SBOM with vulnerability data
bun run sbom:security

# Generate all formats
bun run scripts/generate-sbom.ts --all-formats

# Generate specific format
bun run scripts/generate-sbom.ts --format spdx-json --output-dir ./reports
```

### Compliance Features

- **French Government Compliance**: Meets VITAM program requirements
- **ISO/IEC 5962:2021**: SPDX standard compliance
- **NTIA Minimum Elements**: US government SBOM requirements
- **License Tracking**: Comprehensive license compliance documentation
- **Vulnerability Integration**: Security risk assessment capabilities

### SBOM Scripts

```bash
# Development scripts (build-time tools)
bun run sbom                    # Generate compliance SBOM
bun run sbom:spdx              # SPDX compliance format
bun run sbom:cyclonedx         # CycloneDX security format
bun run sbom:compliance        # Full compliance package
bun run sbom:security          # Security-focused SBOM

# Direct script usage
bun run scripts/generate-sbom.ts --help
```

## Development

### Project Structure

```
src/
├── cli/                    # CLI parsing & command routing
├── api/                    # Internal API (in-process, no HTTP)
│   ├── commands/          # Command handlers
│   ├── queries/           # Query handlers
│   ├── dto.ts             # Data transfer objects
│   ├── errors.ts          # Typed error system
│   └── index.ts           # Public API surface
├── core/                   # Business logic (future)
├── infra/                  # Infrastructure adapters (future)
└── shared/                 # Cross-cutting utilities
scripts/                    # Development & build tools (TypeScript)
├── security-audit.ts       # Container-based security scanning
├── release-pack.ts         # Release packaging automation
└── smoke-test.ts           # Binary testing & validation
```

### Scripts

```bash
# Development
bun run dev                 # Run CLI in development mode
bun run test                # Run all tests
bun run test:watch          # Run tests in watch mode

# Code Quality
bun run lint                # Lint code
bun run format              # Format code
bun run typecheck           # Type checking

# Security
bun run security:audit      # Run comprehensive security scan
bun run security:audit:ci   # CI security scan (fails on high+ severity)
bun run security:audit:json # Generate JSON security report

# SBOM Generation (Build-time tools)
bun run sbom                # Generate compliance SBOM
bun run sbom:spdx           # Generate SPDX format for compliance
bun run sbom:cyclonedx      # Generate CycloneDX format
bun run sbom:compliance     # Full compliance package
bun run sbom:security       # Security-focused SBOM with vulnerability data

# Build & Release
bun run build:cli           # Compile binary
bun run smoke:cli           # Run smoke tests
bun run release:pack        # Create release package
```

### Testing

```bash
# Unit tests
bun run test:unit

# Integration tests
bun run test:integration

# All tests with coverage
bun run test -- --coverage
```

### Security & Development Tools

The project includes **container-based security tooling** for comprehensive vulnerability scanning:

```bash
# Full security audit (dependencies + code)
bun run security:audit

# Check container image status
bun run security:audit --check-only

# Force update security scanner images
bun run security:audit --update-images

# Run in CI mode (strict thresholds)
bun run security:audit:ci
```

**Features:**
- **Trivy**: Dependency vulnerability scanning with CVE database
- **Semgrep**: Static application security testing (SAST) for code patterns
- **Container-based**: Uses Podman for isolated, up-to-date security tools
- **Smart caching**: Only downloads image updates when needed

## Architecture

### CLI-First Approach

v5 starts with a **CLI-only foundation** to:

- Minimize complexity and maximize reliability
- Enable thorough testing of the core API
- Provide a stable contract for future UI integration

### Internal API Design

- **In-process only** - no HTTP servers or network sockets
- **JSON-safe DTOs** with dates as ISO strings
- **Typed errors** mapped to appropriate exit codes
- **Modular commands** and queries for clean separation

### Exit Codes

- `0` - Success
- `1` - System error (file I/O, permissions, etc.)
- `2` - Usage error (invalid flags, arguments, etc.)

## CLI Flags

All commands support these standard flags:

- `--help` - Show command help
- `--version` - Show version information
- `--verbose` - Enable detailed logging
- `--no-color` - Disable colored output
- `--log-format json` - Output structured JSON logs

## Contributing

### Development Guidelines

- **TypeScript everywhere** with strict mode enabled
- **ESLint + Prettier** for consistent formatting
- **Vitest** for testing with good coverage
- **Container-based security** with Trivy + Semgrep
- **No runtime network dependencies** (containers only in development)
- **Path aliases** (`@api/*`, `@cli/*`, etc.)

### Development Environment Setup

```bash
# 1. Install dependencies
bun install

# 2. Verify security tools (requires Podman)
bun run security:audit --check-only

# 3. Run full quality checks
bun run typecheck && bun run lint && bun run security:audit

# 4. Build and test
bun run build:cli && bun run smoke:cli
```

### Commit Guidelines

- Use conventional commits format
- Keep commits atomic and focused
- Include tests for new functionality
- Ensure CI passes before merging

## Roadmap

**Phase 1 (Current): CLI Foundation**

- ✅ Project setup and CI/CD
- ✅ CLI parsing and help system
- ✅ Version management and health checks
- ✅ SBOM generation (SPDX & CycloneDX)
- ✅ Compliance and security reporting
- 🔄 Error handling and logging
- ⏳ Core inventory engine
- ⏳ File hashing and deduplication

**Phase 2: Advanced Features**

- ⏳ Database integration
- ⏳ Export formats (JSON, CSV, etc.)
- ⏳ Pause/resume functionality
- ⏳ Progress reporting

**Phase 3: UI Integration**

- ⏳ Desktop UI (Electron/Tauri)
- ⏳ Visual file tree explorer
- ⏳ Interactive duplicate management

## License

CeCILL 2.1 License - see [LICENSE](LICENSE) for details.

This software is governed by the CeCILL license under French law and abiding by the rules of distribution of free software.

## Copyright

© République française – Ministère de la Culture (SNUM) / CIAF / DINUM dans le cadre du programme interministériel VITAM

## Compliance & Security

### SBOM Standards Compliance

- **SPDX 2.3** (ISO/IEC 5962:2021): License compliance and regulatory requirements
- **CycloneDX 1.5** (OWASP): Security vulnerability tracking and risk management
- **NTIA Minimum Elements**: US government SBOM requirements
- **French Government**: VITAM program compliance standards

### Security Features

- **Container-based security scanning** with Trivy and Semgrep
- **Dependency vulnerability tracking** with real-time updates
- **License compliance verification** with detailed attribution
- **Supply chain transparency** with complete dependency traceability

## Support

- **Issues**: [GitHub Issues](https://github.com/ProgrammeVitam/archifiltre/issues)
- **Discussions**: [GitHub Discussions](https://github.com/ProgrammeVitam/archifiltre/discussions)
- **Official Contact**: archifiltre@programmevitam.fr

## About VITAM Program

The VITAM program is an interministerial initiative for digital archiving, aimed at providing public administrations with a complete solution for the long-term preservation and access to their digital archives.

Learn more: https://www.programmevitam.fr/

---

**Remember**: Archifiltre is designed to be **100% offline and privacy-friendly**. Your data never leaves your machine.

**République française – Ministère de la Culture (SNUM) / CIAF / DINUM**  
**Programme interministériel VITAM**
