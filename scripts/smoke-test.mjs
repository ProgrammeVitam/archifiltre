#!/usr/bin/env node
/**
 * Smoke Test Script for Archifiltre CLI
 *
 * Runs basic smoke tests on the compiled binary to ensure:
 * - Binary executes correctly
 * - --version format is correct
 * - --help contains required sections
 * - No network activity (basic check)
 * - Exit codes are appropriate
 */

import { spawn } from 'child_process';
import { access, constants } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = dirname(__dirname);
const binaryPath = join(projectRoot, 'archifiltre');

/**
 * ANSI color codes for output formatting
 */
const colors = {
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
function colorize(text, color) {
  if (process.env.NO_COLOR === '1' || process.env.CI === 'true') {
    return text;
  }
  return `${colors[color]}${text}${colors.reset}`;
}

/**
 * Logs a message with timestamp and color
 */
function log(message, color = 'reset') {
  const timestamp = new Date().toISOString();
  console.log(`${colorize(`[${timestamp}]`, 'gray')} ${colorize(message, color)}`);
}

/**
 * Runs a command and returns the result
 */
function runCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const child = spawn(command, args, {
      stdio: 'pipe',
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
      const duration = Date.now() - startTime;
      resolve({
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        duration,
      });
    });

    child.on('error', error => {
      reject(error);
    });

    // Kill process after 30 seconds to prevent hanging
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
        reject(new Error('Command timed out after 30 seconds'));
      }
    }, 30000);
  });
}

/**
 * Checks if the binary exists and is executable
 */
async function checkBinaryExists() {
  log('Checking binary existence...', 'blue');

  try {
    await access(binaryPath, constants.F_OK | constants.X_OK);
    log(`✓ Binary exists and is executable: ${binaryPath}`, 'green');
    return true;
  } catch (error) {
    log(`✗ Binary not found or not executable: ${binaryPath}`, 'red');
    log(`Error: ${error.message}`, 'red');
    return false;
  }
}

/**
 * Tests the --version flag
 */
async function testVersionFlag() {
  log('Testing --version flag...', 'blue');

  try {
    const result = await runCommand(binaryPath, ['--version']);

    if (result.exitCode !== 0) {
      log(`✗ --version exited with code ${result.exitCode}`, 'red');
      if (result.stderr) {
        log(`Stderr: ${result.stderr}`, 'red');
      }
      return false;
    }

    // Check version format: archifiltre/X.Y.Z platform-arch runtime
    const versionRegex = /^archifiltre\/\d+\.\d+\.\d+(-\w+)? \w+-\w+ \w+-v\d+\.\d+\.\d+$/;

    if (!versionRegex.test(result.stdout)) {
      log(`✗ Version format is incorrect`, 'red');
      log(`Expected format: archifiltre/X.Y.Z platform-arch runtime-vX.Y.Z`, 'yellow');
      log(`Actual output: ${result.stdout}`, 'yellow');
      return false;
    }

    log(`✓ --version format is correct: ${result.stdout}`, 'green');
    return true;
  } catch (error) {
    log(`✗ --version failed: ${error.message}`, 'red');
    return false;
  }
}

/**
 * Tests the --help flag
 */
async function testHelpFlag() {
  log('Testing --help flag...', 'blue');

  try {
    const result = await runCommand(binaryPath, ['--help']);

    if (result.exitCode !== 0) {
      log(`✗ --help exited with code ${result.exitCode}`, 'red');
      if (result.stderr) {
        log(`Stderr: ${result.stderr}`, 'red');
      }
      return false;
    }

    const helpOutput = result.stdout.toLowerCase();
    const requiredSections = ['usage', 'commands', 'version'];
    const missingSections = [];

    for (const section of requiredSections) {
      if (!helpOutput.includes(section)) {
        missingSections.push(section);
      }
    }

    if (missingSections.length > 0) {
      log(`✗ Help output missing required sections: ${missingSections.join(', ')}`, 'red');
      return false;
    }

    // Check for basic content presence (Oclif format doesn't show flags in main help)
    const requiredContent = ['privacy-friendly', 'offline'];
    const missingFlags = [];

    for (const content of requiredContent) {
      if (!helpOutput.includes(content)) {
        missingFlags.push(content);
      }
    }

    if (missingFlags.length > 0) {
      log(`✗ Help output missing required content: ${missingFlags.join(', ')}`, 'red');
      return false;
    }

    log(`✓ --help contains all required sections and flags`, 'green');
    return true;
  } catch (error) {
    log(`✗ --help failed: ${error.message}`, 'red');
    return false;
  }
}

/**
 * Tests the health command
 */
async function testHealthCommand() {
  log('Testing health command...', 'blue');

  try {
    const result = await runCommand(binaryPath, ['health']);

    // Health command can exit with 0 (healthy) or 1 (issues detected)
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      log(`✗ Health command exited with unexpected code ${result.exitCode}`, 'red');
      if (result.stderr) {
        log(`Stderr: ${result.stderr}`, 'red');
      }
      return false;
    }

    if (!result.stdout) {
      log(`✗ Health command produced no output`, 'red');
      return false;
    }

    const healthOutput = result.stdout.toLowerCase();
    if (!healthOutput.includes('system health')) {
      log(`✗ Health output doesn't contain 'System Health'`, 'red');
      return false;
    }

    log(`✓ Health command works correctly (exit code: ${result.exitCode})`, 'green');
    return true;
  } catch (error) {
    log(`✗ Health command failed: ${error.message}`, 'red');
    return false;
  }
}

/**
 * Tests invalid command handling
 */
async function testInvalidCommand() {
  log('Testing invalid command handling...', 'blue');

  try {
    const result = await runCommand(binaryPath, ['nonexistent-command']);

    if (result.exitCode !== 2) {
      log(`✗ Invalid command should exit with code 2, got ${result.exitCode}`, 'red');
      return false;
    }

    if (!result.stderr) {
      log(`✗ Invalid command should produce error output`, 'red');
      return false;
    }

    log(`✓ Invalid command handling works correctly`, 'green');
    return true;
  } catch (error) {
    log(`✗ Invalid command test failed: ${error.message}`, 'red');
    return false;
  }
}

/**
 * Basic network isolation check
 */
async function testNetworkIsolation() {
  log('Testing network isolation...', 'blue');

  try {
    // Run health command and check if it completes quickly (no network delays)
    const startTime = Date.now();
    const result = await runCommand(binaryPath, ['health']);
    const duration = Date.now() - startTime;

    // Health check should complete quickly (under 5 seconds) if no network activity
    if (duration > 5000) {
      log(`✗ Health command took ${duration}ms, possible network activity`, 'yellow');
      log(`Note: This could also indicate system performance issues`, 'yellow');
      return false;
    }

    // Check if output mentions network isolation
    if (result.stdout.toLowerCase().includes('network')) {
      log(`✓ Network isolation mentioned in health check`, 'green');
    }

    log(`✓ No obvious network activity detected (completed in ${duration}ms)`, 'green');
    return true;
  } catch (error) {
    log(`✗ Network isolation test failed: ${error.message}`, 'red');
    return false;
  }
}

/**
 * Main smoke test runner
 */
async function runSmokeTests() {
  log('Starting Archifiltre CLI Smoke Tests', 'bold');
  log('=====================================', 'bold');

  const tests = [
    { name: 'Binary Existence', fn: checkBinaryExists },
    { name: 'Version Flag', fn: testVersionFlag },
    { name: 'Help Flag', fn: testHelpFlag },
    { name: 'Health Command', fn: testHealthCommand },
    { name: 'Invalid Command', fn: testInvalidCommand },
    { name: 'Network Isolation', fn: testNetworkIsolation },
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      const success = await test.fn();
      if (success) {
        passed++;
      } else {
        failed++;
      }
    } catch (error) {
      log(`✗ Test "${test.name}" threw an error: ${error.message}`, 'red');
      failed++;
    }

    // Add spacing between tests
    console.log('');
  }

  // Summary
  log('=====================================', 'bold');
  log('Smoke Test Results', 'bold');
  log('=====================================', 'bold');
  log(`Total tests: ${tests.length}`, 'blue');
  log(`Passed: ${passed}`, passed > 0 ? 'green' : 'gray');
  log(`Failed: ${failed}`, failed > 0 ? 'red' : 'gray');

  if (failed > 0) {
    log('Some smoke tests failed. Check the output above for details.', 'red');
    process.exit(1);
  } else {
    log('All smoke tests passed! 🎉', 'green');
    process.exit(0);
  }
}

// Handle process signals
process.on('SIGINT', () => {
  log('Smoke tests interrupted', 'yellow');
  process.exit(130);
});

process.on('SIGTERM', () => {
  log('Smoke tests terminated', 'yellow');
  process.exit(143);
});

// Run the smoke tests
runSmokeTests().catch(error => {
  log(`Fatal error in smoke tests: ${error.message}`, 'red');
  console.error(error.stack);
  process.exit(1);
});
