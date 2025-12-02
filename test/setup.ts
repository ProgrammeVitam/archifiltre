/**
 * Vitest setup file for custom matchers and global configuration
 */

import { expect } from 'vitest';

// Extend the expect interface for TypeScript
interface CustomMatchers<R = unknown> {
  toBeOneOf(expected: readonly unknown[]): R;
}

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Assertion<T = any> extends CustomMatchers<T> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchersContaining extends CustomMatchers {}
}

// Add custom matchers
expect.extend({
  toBeOneOf(received: unknown, expected: readonly unknown[]) {
    const pass = expected.includes(received);

    if (pass) {
      return {
        message: () => `expected ${received} not to be one of ${expected.join(', ')}`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${received} to be one of ${expected.join(', ')}`,
        pass: false,
      };
    }
  },
});
