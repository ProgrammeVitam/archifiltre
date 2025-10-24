# Archifiltre v5

**Privacy-friendly, 100% offline desktop tool for inventorying large file trees, detecting duplicates/similarities, and producing exports for cleanup/analysis.**

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

MIT License - see [LICENSE](LICENSE) for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/ProgrammeVitam/archifiltre/issues)
- **Discussions**: [GitHub Discussions](https://github.com/ProgrammeVitam/archifiltre/discussions)

---

**Remember**: Archifiltre is designed to be **100% offline and privacy-friendly**. Your data never leaves your machine.
