# Archifiltre v5 - Specifications, Items & Tests

This document defines the technical specifications, feature requirements, and testing criteria for Archifiltre v5.

## Overview

Archifiltre v5 is a privacy-friendly, 100% offline desktop tool for inventorying large file trees, detecting duplicates/similarities, and producing exports for cleanup/analysis. This document serves as the authoritative specification for development and testing.

## Core Requirements

### Functional Requirements

#### FR-001: Single Binary Distribution

- **Description**: The application must compile to a single, self-contained executable
- **Implementation**: Use Bun's compile feature to create standalone binaries
- **Platforms**: Linux x64, macOS x64/ARM64, Windows x64
- **Size Limit**: Binary should be <150MB for reasonable distribution

#### FR-002: CLI-First Architecture

- **Description**: Primary interface must be command-line with comprehensive help
- **Commands**: `help`, `version`, `health`, plus future scanning commands
- **Flags**: Long-form only (`--help`, `--verbose`, `--no-color`, `--log-format`)
- **Exit Codes**: 0=success, 1=system error, 2=usage error

#### FR-003: 100% Offline Operation

- **Description**: No network communication at runtime
- **Verification**: Network isolation tests must pass
- **Exception**: Build-time dependency installation only
- **Security**: No telemetry, analytics, or external data transmission

#### FR-004: Privacy Protection

- **Description**: All data processing happens locally
- **Storage**: Local file system only
- **Logging**: No sensitive data in logs
- **Metadata**: No tracking or identification data

### Non-Functional Requirements

#### NFR-001: Performance

- **Startup Time**: CLI commands must start within 200ms
- **Memory Usage**: Base CLI operations under 50MB RAM
- **Scalability**: Support for future 1M+ file inventories
- **Responsiveness**: Interactive commands respond within 100ms

#### NFR-002: Reliability

- **Crash Recovery**: Graceful handling of interruptions
- **Error Messages**: Human-readable with actionable hints
- **Logging**: Structured logging with appropriate levels
- **Validation**: Input validation with clear error messages

#### NFR-003: Maintainability

- **Code Coverage**: 85%+ test coverage for production code
- **Documentation**: API documentation and user guides
- **Architecture**: Clear separation of concerns
- **Dependencies**: Minimal runtime dependencies

## Technical Specifications

### Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│                     CLI Layer                               │
│  • Argument parsing      • Help generation                 │
│  • Command routing       • Error formatting                │
│  • Exit code mapping     • Output formatting               │
└─────────────────────────────────────────────────────────────┘
                                │
┌─────────────────────────────────────────────────────────────┐
│                 Internal API Layer                         │
│  • Commands (actions)    • DTOs (data structures)         │
│  • Queries (read ops)    • Error types                    │
│  • Formatters            • Validation                     │
└─────────────────────────────────────────────────────────────┘
                                │
┌─────────────────────────────────────────────────────────────┐
│              Core Business Logic (Future)                  │
│  • File scanning         • Hash computation               │
│  • Duplicate detection   • Analysis algorithms            │
│  • Data persistence      • Report generation              │
└─────────────────────────────────────────────────────────────┘
```

### Data Transfer Objects (DTOs)

#### VersionInfo

```typescript
interface VersionInfo {
  appVersion: string; // Semantic version
  gitSha: string; // Short Git SHA
  buildDateUtc: string; // ISO datetime string
  os: string; // Normalized OS name
  arch: string; // Normalized architecture
}
```

#### HealthReport

```typescript
interface HealthReport {
  ok: boolean; // Overall health status
  checks: string[]; // Individual check results
  timestamp?: string; // ISO datetime string
}
```

#### Error Types

```typescript
type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'MISSING_ARGUMENT'
  | 'INVALID_FLAG' // User errors
  | 'FILE_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'DISK_FULL' // System errors
  | 'RESOURCE_BUSY'
  | 'OPERATION_IN_PROGRESS'; // Conflict errors
```

### CLI Contract Specifications

#### Version Command

- **Format**: `vX.Y.Z (sha abcdef7, 2025-01-01T12:34:56.123Z, os=linux, arch=x64)`
- **Regex**: `^v\d+\.\d+\.\d+(-\w+)? \(sha [0-9a-f]{7,9}|unknown, \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z, os=\w+, arch=\w+\)$`
- **Sources**: Version from package.json/env, SHA from git/env, date from build time
- **JSON Mode**: Full VersionInfo object when `--log-format json`

#### Help Command

- **Required Sections**: USAGE, COMMANDS, OPTIONS, EXAMPLES, EXIT CODES
- **Required Flags**: `--help`, `--version`, `--verbose`, `--no-color`, `--log-format`
- **Format**: Colored by default, plain text with `--no-color` or `CI=true`
- **Exit**: Always exit code 0

#### Health Command

- **Checks**: Node.js version, memory, temp dir, working dir, network isolation, permissions
- **Format**: `✓`/`✗` indicators with descriptive messages
- **Exit Codes**: 0 if all healthy, 1 if any issues detected
- **JSON Mode**: Full HealthReport object when `--log-format json`

### Build Specifications

#### Environment Variables

- `APP_VERSION`: Application version (defaults to package.json)
- `GIT_SHA`: Git commit SHA (short form preferred)
- `BUILD_DATE`: ISO timestamp of build
- `TARGET_OS`: Target operating system
- `TARGET_ARCH`: Target architecture

#### Compilation

```bash
bun build src/cli/archifiltre.ts --compile --outfile archifiltre
```

#### Package Structure

```
archifiltre-${os}-${arch}-${version}.tar.gz
├── archifiltre              # Executable binary
├── LICENSE                  # MIT license
└── README.quickstart.md     # Quick start guide
```

## Test Specifications

### Unit Tests

#### Coverage Requirements

- **Minimum Coverage**: 85% for production code
- **Critical Paths**: 100% coverage for error handling
- **Excluded**: Test utilities, mock objects
- **Tools**: Vitest with V8 coverage provider

#### Test Categories

##### API Commands Tests

```typescript
describe('Version Command', () => {
  it('should return valid VersionInfo object');
  it('should handle environment variables correctly');
  it('should format output according to spec');
  it('should validate timestamp format');
});

describe('Health Command', () => {
  it('should perform all required checks');
  it('should handle check failures gracefully');
  it('should format output correctly');
  it('should return appropriate exit codes');
});
```

##### Error Handling Tests

```typescript
describe('Error System', () => {
  it('should map error types to exit codes correctly');
  it('should format errors for display');
  it('should preserve error context');
  it('should handle verbose mode');
});
```

### Integration Tests

#### CLI-to-API Integration

```typescript
describe('CLI Integration', () => {
  it('should parse arguments correctly');
  it('should call appropriate API functions');
  it('should format output according to flags');
  it('should handle errors with correct exit codes');
});
```

#### Cross-Platform Compatibility

- Test binary execution on all target platforms
- Verify file system operations work correctly
- Check platform-specific features (permissions, etc.)

### Smoke Tests

#### Binary Validation

- **Executable Check**: Binary runs and responds to basic commands
- **Version Format**: Output matches exact specification regex
- **Help Content**: Contains all required sections and flags
- **Exit Codes**: Correct codes for success/error scenarios
- **Network Isolation**: No network activity during execution

#### Container Testing

```bash
# Clean Alpine Linux container test
docker run --rm -v $(pwd):/workspace -w /workspace alpine:latest ./archifiltre --version
```

### Performance Tests

#### Startup Performance

- **Target**: CLI commands start within 200ms
- **Measurement**: Time from process start to first output
- **Environment**: Cold start on typical hardware

#### Memory Usage

- **Target**: Base operations under 50MB RAM
- **Measurement**: Peak memory during command execution
- **Monitoring**: RSS and heap usage

### Security Tests

#### Network Isolation

- **Method**: Monitor network connections during execution
- **Tools**: `netstat`, `lsof`, container networking disabled
- **Requirement**: Zero network connections opened

#### File System Access

- **Principle**: Respect existing permissions
- **Test**: Verify graceful handling of permission denied
- **Validation**: No privilege escalation attempts

## Quality Gates

### Development Quality Gates

#### Pre-Commit

- [ ] All tests pass locally
- [ ] Code formatted with Prettier
- [ ] ESLint passes with no errors
- [ ] TypeScript compilation succeeds

#### Pull Request

- [ ] All CI checks pass
- [ ] Code review approved
- [ ] Test coverage maintained
- [ ] Documentation updated

#### Release

- [ ] Smoke tests pass in clean environment
- [ ] Cross-platform compatibility verified
- [ ] Release notes updated
- [ ] Artifacts generated with checksums

### Continuous Integration Requirements

#### Basic Pipeline (ci.yml)

1. **Lint and Format**: ESLint + Prettier validation
2. **Type Check**: TypeScript compilation
3. **Unit Tests**: All unit tests with coverage
4. **Integration Tests**: CLI-to-API integration
5. **Build**: Binary compilation

#### Smoke Pipeline (smoke.yml)

1. **Build Binary**: Compile for target platform
2. **Container Test**: Execute in clean Alpine container
3. **Format Validation**: Version/help format verification
4. **Network Isolation**: Verify no network activity
5. **Artifact Generation**: Create release packages

### Acceptance Criteria

#### Minimum Viable Product (MVP)

- [ ] Single binary builds on Linux x64
- [ ] CLI help system functional
- [ ] Version information accurate
- [ ] Health checks operational
- [ ] Error handling robust
- [ ] Tests pass consistently
- [ ] Documentation complete

#### Production Ready

- [ ] Cross-platform binaries (Linux, macOS, Windows)
- [ ] Comprehensive test coverage (>85%)
- [ ] Performance targets met
- [ ] Security validation passed
- [ ] User documentation complete
- [ ] CI/CD pipeline operational

## Validation Procedures

### Manual Testing Checklist

#### Basic Functionality

- [ ] `./archifiltre --version` shows correct format
- [ ] `./archifiltre --help` shows complete help
- [ ] `./archifiltre health` performs all checks
- [ ] Invalid commands show appropriate errors
- [ ] Exit codes match specification

#### Flag Combinations

- [ ] `--verbose` increases output detail
- [ ] `--no-color` removes ANSI codes
- [ ] `--log-format json` outputs valid JSON
- [ ] Flag precedence works correctly

#### Error Scenarios

- [ ] Invalid flags produce usage errors (exit 2)
- [ ] System errors produce system errors (exit 1)
- [ ] Error messages are helpful
- [ ] Verbose mode shows additional detail

### Automated Validation

#### Version Format Validation

```bash
# Test version format matches specification
./archifiltre --version | grep -E '^v\d+\.\d+\.\d+(-\w+)? \(sha [0-9a-f]{7,9}|unknown, \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z, os=\w+, arch=\w+\)$'
```

#### Help Content Validation

```bash
# Verify required sections in help output
./archifiltre --help | grep -i "EXAMPLES\|EXIT CODES\|OPTIONS"
```

#### Network Isolation Validation

```bash
# Ensure no network activity during execution
timeout 5s strace -e trace=network ./archifiltre health 2>&1 | grep -v "+++\|---" || echo "No network calls detected"
```

## Traceability Matrix

| Requirement              | Implementation        | Unit Test          | Integration Test   | Smoke Test          |
| ------------------------ | --------------------- | ------------------ | ------------------ | ------------------- |
| FR-001 Single Binary     | Bun compile           | N/A                | Binary execution   | Container test      |
| FR-002 CLI Interface     | commands-registry.ts  | CLI parsing tests  | End-to-end CLI     | Help/version format |
| FR-003 Offline Operation | No network code       | Mock network calls | No network mocking | Network isolation   |
| FR-004 Privacy           | Local-only processing | Data flow tests    | No external calls  | Container isolation |
| NFR-001 Performance      | Efficient algorithms  | Algorithm tests    | Response time      | Startup time        |
| NFR-002 Reliability      | Error handling        | Error scenarios    | Recovery tests     | Crash scenarios     |
| NFR-003 Maintainability  | Clean architecture    | Unit coverage      | API contracts      | Smoke coverage      |

## Future Specifications

### Phase 2: File Scanning

- File system traversal specifications
- Metadata collection requirements
- Progress reporting protocols
- Database schema definitions

### Phase 3: Content Analysis

- Hashing algorithm specifications
- Duplicate detection criteria
- Performance benchmarks
- Memory usage limits

### Phase 4: Reporting

- Export format specifications
- Query language definition
- Report template system
- API compatibility requirements

---

**Document Version**: 1.0  
**Last Updated**: October 20, 2025  
**Review Cycle**: Monthly or before major releases  
**Approval**: Technical Lead, QA Lead

This document serves as the contract between development, testing, and product teams. All changes require approval through the standard change management process.
