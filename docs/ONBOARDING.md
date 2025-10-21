# Archifiltre v5 - Developer Onboarding

Welcome to the Archifiltre v5 development team! This guide will help you get up and running quickly with our codebase.

## What is Archifiltre?

Archifiltre is a **privacy-friendly, 100% offline** desktop tool that inventories large file trees, detects duplicates/similarities, and produces exports for cleanup/analysis. Version 5 is a complete rebuild focused on **speed, reliability, and modularity**.

## Quick Start (5 minutes)

### Prerequisites

- **[Bun](https://bun.sh/)** >= 1.0.0 (our runtime and package manager)
- **Node.js** >= 18 (for compatibility)
- **Git** (for version control)

### Setup

```bash
# 1. Clone the repository
git clone https://github.com/ProgrammeVitam/archifiltre.git
cd archifiltre

# 2. Install dependencies
bun install

# 3. Build the CLI binary
bun run build:cli

# 4. Run smoke tests
bun run smoke:cli

# 5. Try the CLI
./archifiltre --help
./archifiltre --version
./archifiltre health
```

🎉 **You're ready to go!** If all commands work, you have a functional development environment.

## Project Architecture Overview

### High-Level Design

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   CLI Layer     │    │  Internal API   │    │  Core/Infra     │
│                 │    │                 │    │                 │
│ • Arg parsing   │───▶│ • Commands      │───▶│ • File scanning │
│ • Help/version  │    │ • Queries       │    │ • Hashing       │
│ • Error display │    │ • DTOs          │    │ • Database      │
│ • Exit codes    │    │ • Error types   │    │ • Exports       │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### Key Principles

- **CLI-first**: Start with solid command-line interface
- **Internal API**: In-process communication (no HTTP/sockets)
- **Single binary**: Compiled with `bun compile`
- **100% offline**: No network dependencies at runtime
- **Typed errors**: Proper error handling with exit codes

## Directory Structure

```
archifiltre/
├── src/
│   ├── cli/                    # CLI parsing & command routing
│   │   ├── archifiltre.ts     # Main entry point (compiled target)
│   │   └── commands-registry.ts # Command mapping & execution
│   ├── api/                    # Internal API (in-process)
│   │   ├── commands/          # Command implementations
│   │   ├── queries/           # Query implementations
│   │   ├── dto.ts             # Data Transfer Objects
│   │   ├── errors.ts          # Typed error system
│   │   └── index.ts           # Public API surface
│   ├── core/                   # Business logic (future)
│   ├── infra/                  # Infrastructure adapters (future)
│   └── shared/                 # Cross-cutting utilities
├── test/
│   ├── unit/                  # Unit tests
│   └── integration/           # Integration tests
├── scripts/                   # Build and utility scripts
├── docs/                      # Documentation
└── .github/workflows/         # CI/CD
```

## Development Workflow

### Daily Development

```bash
# Start development mode
bun run dev -- --help              # Test CLI in dev mode

# Run tests
bun run test                       # All tests
bun run test:watch                 # Watch mode
bun run test:unit                  # Unit tests only
bun run test:integration           # Integration tests only

# Code quality
bun run lint                       # Check linting
bun run format                     # Format code
bun run typecheck                  # Type checking

# Build and test
bun run build:cli                  # Build binary
bun run smoke:cli                  # Run smoke tests
```

### TypeScript Path Aliases

We use path aliases for clean imports:

```typescript
// ✅ Good
import { version } from '@api/commands/version.ts';
import { executeCommand } from '@cli/commands-registry.ts';
import { sleep } from '@shared/index.ts';

// ❌ Bad
import { version } from '../../../api/commands/version.ts';
```

Available aliases:

- `@cli/*` → `src/cli/*`
- `@api/*` → `src/api/*`
- `@core/*` → `src/core/*`
- `@infra/*` → `src/infra/*`
- `@shared/*` → `src/shared/*`

## Testing Strategy

### Test Structure

- **Unit tests**: Test individual functions/modules
- **Integration tests**: Test CLI-to-API communication
- **Smoke tests**: Test compiled binary functionality

### Writing Tests

```typescript
// Example unit test
import { describe, it, expect } from 'vitest';
import { version } from '@api/commands/version.ts';

describe('Version Command', () => {
  it('should return valid version info', () => {
    const versionInfo = version();

    expect(versionInfo.appVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(versionInfo.buildDateUtc).toMatch(/Z$/);
  });
});
```

### Running Specific Tests

```bash
# Run tests matching a pattern
bun run test version
bun run test health
bun run test cli

# Run specific test file
bun run test test/unit/version-format.test.ts

# Run with coverage
bun run test -- --coverage
```

## Code Style Guide

### TypeScript Guidelines

1. **Use strict TypeScript** - all strict flags enabled
2. **Explicit return types** for public functions
3. **Interface over type** for object shapes
4. **Proper error handling** - use typed errors

```typescript
// ✅ Good
export async function health(): Promise<HealthReport> {
  try {
    // implementation
    return { ok: true, checks: [] };
  } catch (error) {
    throw SystemError.unknown(error);
  }
}

// ❌ Bad
export async function health() {
  // implementation - no return type, no error handling
}
```

### Error Handling

Always use our typed error system:

```typescript
import { UserInputError, SystemError } from '@api/errors.ts';

// ✅ Good
if (!filePath) {
  throw UserInputError.missingArgument('file-path');
}

if (!fs.existsSync(filePath)) {
  throw SystemError.fileNotFound(filePath);
}

// ❌ Bad
if (!filePath) {
  throw new Error('Missing file path');
}
```

## CLI Command Development

### Adding a New Command

1. **Add to API layer** (`src/api/commands/new-command.ts`)
2. **Register in CLI** (`src/cli/commands-registry.ts`)
3. **Write tests** (`test/unit/` and `test/integration/`)
4. **Update help text**

Example command structure:

```typescript
// src/api/commands/example.ts
export interface ExampleOptions {
  verbose: boolean;
  outputPath?: string;
}

export function example(options: ExampleOptions): ExampleResult {
  try {
    // Command implementation
    return { success: true };
  } catch (error) {
    throw SystemError.unknown(error);
  }
}

// src/cli/commands-registry.ts
case 'example':
  return await executeExample(ctx);
```

### CLI Contract Requirements

All commands must support:

- `--help` flag
- `--verbose` flag
- `--no-color` flag
- `--log-format json` flag
- Proper exit codes (0=success, 1=system error, 2=usage error)

## API Design Patterns

### DTOs (Data Transfer Objects)

```typescript
// ✅ JSON-safe DTOs
export interface VersionInfo {
  appVersion: string;
  gitSha: string;
  buildDateUtc: string; // ISO string, not Date object
  os: string;
  arch: string;
}

// ❌ Non-JSON-safe
export interface BadVersionInfo {
  buildDate: Date; // Not JSON serializable
  metadata: Map<string, any>; // Not JSON serializable
}
```

### Commands vs Queries

- **Commands**: Modify state, perform actions
- **Queries**: Read state, return information

```typescript
// Command (modifies state)
export function startScan(path: string): void {
  // Implementation
}

// Query (reads state)
export function getStatus(): StatusInfo {
  // Implementation
}
```

## CI/CD Pipeline

### Workflows

1. **CI** (`ci.yml`): Lint, build, test
2. **Smoke** (`smoke.yml`): Compile binary, run in clean container

### Branch Strategy

- `main`: Production-ready code
- `develop`: Integration branch
- Feature branches: `feature/description`
- Hotfix branches: `hotfix/description`

### Pull Request Checklist

- [ ] All tests pass
- [ ] Code is formatted (`bun run format`)
- [ ] No linting errors (`bun run lint`)
- [ ] Type checking passes (`bun run typecheck`)
- [ ] Smoke tests pass (`bun run smoke:cli`)
- [ ] Documentation updated if needed

## Debugging Tips

### Common Issues

1. **Binary not executable**: `chmod +x archifiltre`
2. **Path alias not working**: Check `tsconfig.json` and `vitest.config.ts`
3. **Tests failing**: Run `bun run test:unit` to isolate issues

### Debugging Commands

```bash
# Build with verbose output
bun run build:cli --verbose

# Run specific test with debug info
bun run test --reporter=verbose test-pattern

# Check binary dependencies
ldd archifiltre  # Linux
otool -L archifiltre  # macOS
```

## Release Process

### Version Bumping

```bash
# Update version in package.json
# Create git tag
git tag v5.1.0
git push origin v5.1.0

# CI will automatically create release artifacts
```

### Manual Release

```bash
# Build release package
bun run release:pack

# Check dist/ directory
ls -la dist/
```

## Getting Help

### Resources

- **Specs**: `docs/SPECS-ITEMS-Tests.md`
- **Roadmap**: `docs/ROADMAP.md`
- **Issues**: GitHub Issues tab
- **Discussions**: GitHub Discussions

### Ask Questions

- Create GitHub Discussion for architecture questions
- Create GitHub Issue for bugs
- Check existing documentation first

## Next Steps

1. **Explore the codebase**: Start with `src/cli/archifiltre.ts`
2. **Run the tests**: Get familiar with our test patterns
3. **Make a small change**: Try adding a new flag or option
4. **Read the specs**: Understand the full vision in `docs/`

Welcome to the team! 🚀

---

**Need help?** Create a GitHub Discussion or reach out to the team. We're here to help you succeed!
