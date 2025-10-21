#!/usr/bin/env bash
#
# Try Script for Archifiltre CI Artifacts
#
# Downloads CI artifacts, verifies checksums, and runs smoke tests
# Usage: ./scripts/try.sh [ARTIFACT_URL] [--keep-files]
#
# This script is designed to test release artifacts from CI builds
# before they are officially released.

set -euo pipefail

# Script configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TEMP_DIR="$PROJECT_ROOT/.try-temp"
KEEP_FILES=false
VERBOSE=false

# Color codes
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly GRAY='\033[0;90m'
readonly BOLD='\033[1m'
readonly NC='\033[0m' # No Color

# Logging functions
log() {
    local color="${2:-$NC}"
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    echo -e "${GRAY}[$timestamp]${NC} ${color}$1${NC}"
}

log_info() { log "$1" "$BLUE"; }
log_success() { log "$1" "$GREEN"; }
log_warning() { log "$1" "$YELLOW"; }
log_error() { log "$1" "$RED"; }
log_bold() { log "$1" "$BOLD"; }

# Error handling
cleanup() {
    if [[ "$KEEP_FILES" == "false" && -d "$TEMP_DIR" ]]; then
        log_info "Cleaning up temporary files..."
        rm -rf "$TEMP_DIR"
        log_success "✓ Cleanup completed"
    fi
}

error_exit() {
    log_error "✗ $1"
    cleanup
    exit 1
}

# Signal handlers
trap cleanup EXIT
trap 'error_exit "Script interrupted"' INT TERM

# Usage information
show_usage() {
    cat << EOF
Usage: $0 [ARTIFACT_URL] [OPTIONS]

Downloads and tests Archifiltre CI artifacts.

Arguments:
  ARTIFACT_URL    URL to the release archive (tar.gz)
                  If not provided, will try to detect from environment

Options:
  --keep-files    Keep downloaded files after testing
  --verbose       Enable verbose output
  --help, -h      Show this help message

Examples:
  # Test with explicit URL
  $0 https://github.com/ProgrammeVitam/archifiltre/releases/download/v5.0.0/archifiltre-linux-x64-5.0.0.tar.gz

  # Test with GitHub Actions artifact (requires GITHUB_TOKEN)
  $0 --verbose

  # Keep files for manual inspection
  $0 https://example.com/archifiltre-linux-x64-5.0.0.tar.gz --keep-files

Environment Variables:
  ARTIFACT_URL       URL to download (alternative to first argument)
  GITHUB_TOKEN       GitHub token for downloading GitHub Actions artifacts
  EXPECTED_SHA256    Expected SHA256 hash (optional, will try to download .sha256 file)
  NO_COLOR          Set to '1' to disable colored output

EOF
}

# Parse command line arguments
parse_args() {
    ARTIFACT_URL="${1:-${ARTIFACT_URL:-}}"

    while [[ $# -gt 0 ]]; do
        case $1 in
            --keep-files)
                KEEP_FILES=true
                shift
                ;;
            --verbose)
                VERBOSE=true
                shift
                ;;
            --help|-h)
                show_usage
                exit 0
                ;;
            --*)
                error_exit "Unknown option: $1"
                ;;
            *)
                if [[ -z "$ARTIFACT_URL" ]]; then
                    ARTIFACT_URL="$1"
                fi
                shift
                ;;
        esac
    done

    if [[ -z "$ARTIFACT_URL" ]]; then
        log_error "No artifact URL provided"
        echo
        show_usage
        exit 2
    fi
}

# Detect OS and architecture
detect_platform() {
    local os arch

    case "$(uname -s)" in
        Linux*)     os="linux" ;;
        Darwin*)    os="darwin" ;;
        CYGWIN*|MINGW*|MSYS*) os="win32" ;;
        *)          os="unknown" ;;
    esac

    case "$(uname -m)" in
        x86_64|amd64)   arch="x64" ;;
        arm64|aarch64)  arch="arm64" ;;
        arm*)           arch="arm" ;;
        i386|i686)      arch="ia32" ;;
        *)              arch="unknown" ;;
    esac

    echo "${os}-${arch}"
}

# Download file with progress
download_file() {
    local url="$1"
    local output_path="$2"
    local description="${3:-file}"

    log_info "Downloading $description..."
    log_info "URL: $url"

    if command -v curl >/dev/null 2>&1; then
        curl -L --fail --progress-bar "$url" -o "$output_path"
    elif command -v wget >/dev/null 2>&1; then
        wget --progress=bar:force:noscroll "$url" -O "$output_path"
    else
        error_exit "Neither curl nor wget is available for downloading"
    fi

    if [[ ! -f "$output_path" ]]; then
        error_exit "Download failed: $output_path not created"
    fi

    local size
    size=$(du -h "$output_path" | cut -f1)
    log_success "✓ Downloaded $description ($size)"
}

# Verify SHA256 checksum
verify_checksum() {
    local file_path="$1"
    local expected_hash="${2:-}"
    local checksum_file="${3:-}"

    if [[ -z "$expected_hash" && -z "$checksum_file" ]]; then
        log_warning "No checksum provided, skipping verification"
        return 0
    fi

    log_info "Verifying SHA256 checksum..."

    local actual_hash
    if command -v sha256sum >/dev/null 2>&1; then
        actual_hash=$(sha256sum "$file_path" | cut -d' ' -f1)
    elif command -v shasum >/dev/null 2>&1; then
        actual_hash=$(shasum -a 256 "$file_path" | cut -d' ' -f1)
    else
        log_warning "No SHA256 tool available, skipping checksum verification"
        return 0
    fi

    if [[ -n "$checksum_file" && -f "$checksum_file" ]]; then
        expected_hash=$(head -n1 "$checksum_file" | cut -d' ' -f1)
    fi

    if [[ -z "$expected_hash" ]]; then
        log_warning "No expected hash found, skipping verification"
        return 0
    fi

    if [[ "$actual_hash" == "$expected_hash" ]]; then
        log_success "✓ Checksum verification passed"
        log_success "  SHA256: $actual_hash"
    else
        log_error "✗ Checksum verification failed"
        log_error "  Expected: $expected_hash"
        log_error "  Actual:   $actual_hash"
        return 1
    fi
}

# Extract archive
extract_archive() {
    local archive_path="$1"
    local extract_dir="$2"

    log_info "Extracting archive..."

    mkdir -p "$extract_dir"

    case "$archive_path" in
        *.tar.gz|*.tgz)
            tar -xzf "$archive_path" -C "$extract_dir"
            ;;
        *.tar.bz2|*.tbz2)
            tar -xjf "$archive_path" -C "$extract_dir"
            ;;
        *.tar)
            tar -xf "$archive_path" -C "$extract_dir"
            ;;
        *.zip)
            unzip -q "$archive_path" -d "$extract_dir"
            ;;
        *)
            error_exit "Unsupported archive format: $archive_path"
            ;;
    esac

    log_success "✓ Archive extracted"

    # List extracted files
    if [[ "$VERBOSE" == "true" ]]; then
        log_info "Extracted files:"
        find "$extract_dir" -type f -exec basename {} \; | sort | sed 's/^/  /'
    fi
}

# Find binary in extracted files
find_binary() {
    local extract_dir="$1"
    local binary_name="${2:-archifiltre}"

    # Try exact name first
    local binary_path="$extract_dir/$binary_name"
    if [[ -f "$binary_path" ]]; then
        echo "$binary_path"
        return 0
    fi

    # Try with .exe extension
    binary_path="$extract_dir/$binary_name.exe"
    if [[ -f "$binary_path" ]]; then
        echo "$binary_path"
        return 0
    fi

    # Search for executable files
    local found_binaries
    found_binaries=$(find "$extract_dir" -type f -executable 2>/dev/null | head -1)

    if [[ -n "$found_binaries" ]]; then
        echo "$found_binaries"
        return 0
    fi

    error_exit "No binary found in extracted archive"
}

# Run smoke tests on binary
run_smoke_tests() {
    local binary_path="$1"

    log_bold "Running Smoke Tests"
    log_bold "==================="

    # Make binary executable (in case extraction didn't preserve permissions)
    chmod +x "$binary_path" 2>/dev/null || true

    # Test 1: Version check
    log_info "Test 1: Version check"
    if ! "$binary_path" --version; then
        error_exit "Version check failed"
    fi
    log_success "✓ Version check passed"
    echo

    # Test 2: Help check
    log_info "Test 2: Help check"
    local help_output
    if ! help_output=$("$binary_path" --help); then
        error_exit "Help check failed"
    fi

    # Verify help contains required sections
    local missing_sections=()
    if ! echo "$help_output" | grep -qi "examples"; then
        missing_sections+=("EXAMPLES")
    fi
    if ! echo "$help_output" | grep -qi "exit codes"; then
        missing_sections+=("EXIT CODES")
    fi
    if ! echo "$help_output" | grep -qi "options"; then
        missing_sections+=("OPTIONS")
    fi

    if [[ ${#missing_sections[@]} -gt 0 ]]; then
        log_error "Help output missing sections: ${missing_sections[*]}"
        return 1
    fi

    log_success "✓ Help check passed"
    echo

    # Test 3: Health check
    log_info "Test 3: Health check"
    local health_exit_code=0
    "$binary_path" health || health_exit_code=$?

    # Health can exit with 0 (healthy) or 1 (issues detected)
    if [[ $health_exit_code -ne 0 && $health_exit_code -ne 1 ]]; then
        error_exit "Health check failed with unexpected exit code: $health_exit_code"
    fi

    log_success "✓ Health check passed (exit code: $health_exit_code)"
    echo

    # Test 4: Invalid command handling
    log_info "Test 4: Invalid command handling"
    local invalid_exit_code=0
    "$binary_path" invalid-command-xyz 2>/dev/null || invalid_exit_code=$?

    if [[ $invalid_exit_code -ne 2 ]]; then
        error_exit "Invalid command should exit with code 2, got $invalid_exit_code"
    fi

    log_success "✓ Invalid command handling passed"
    echo

    log_bold "==================="
    log_success "All smoke tests passed! 🎉"
}

# Main execution
main() {
    log_bold "Archifiltre CI Artifact Tester"
    log_bold "==============================="
    echo

    # Parse arguments
    parse_args "$@"

    # Setup
    local platform
    platform=$(detect_platform)
    log_info "Platform: $platform"
    log_info "Artifact URL: $ARTIFACT_URL"
    echo

    # Create temp directory
    rm -rf "$TEMP_DIR"
    mkdir -p "$TEMP_DIR"
    log_success "✓ Created temporary directory: $TEMP_DIR"

    # Download archive
    local archive_name
    archive_name=$(basename "$ARTIFACT_URL")
    local archive_path="$TEMP_DIR/$archive_name"
    download_file "$ARTIFACT_URL" "$archive_path" "release archive"

    # Try to download checksum file
    local checksum_path="$TEMP_DIR/${archive_name}.sha256"
    local checksum_url="${ARTIFACT_URL}.sha256"
    if download_file "$checksum_url" "$checksum_path" "checksum file" 2>/dev/null; then
        log_success "✓ Downloaded checksum file"
    else
        log_warning "Checksum file not available, will skip verification"
        checksum_path=""
    fi

    echo

    # Verify checksum
    verify_checksum "$archive_path" "${EXPECTED_SHA256:-}" "$checksum_path"
    echo

    # Extract archive
    local extract_dir="$TEMP_DIR/extracted"
    extract_archive "$archive_path" "$extract_dir"
    echo

    # Find binary
    log_info "Looking for binary..."
    local binary_path
    binary_path=$(find_binary "$extract_dir")
    log_success "✓ Found binary: $(basename "$binary_path")"
    echo

    # Run smoke tests
    run_smoke_tests "$binary_path"
    echo

    # Summary
    log_bold "==============================="
    log_success "Artifact testing completed successfully!"

    if [[ "$KEEP_FILES" == "true" ]]; then
        log_info "Files kept in: $TEMP_DIR"
        log_info "Binary location: $binary_path"
    else
        log_info "Temporary files will be cleaned up"
    fi

    log_bold "==============================="
}

# Disable colors if requested
if [[ "${NO_COLOR:-}" == "1" ]]; then
    RED="" GREEN="" YELLOW="" BLUE="" GRAY="" BOLD="" NC=""
fi

# Run main function with all arguments
main "$@"
