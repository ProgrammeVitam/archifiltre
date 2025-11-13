module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  extends: ['eslint:recommended'],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'yml'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  rules: {
    // Basic ESLint rules
    'no-unused-vars': 'off', // Use TypeScript version instead
    'no-console': 'error', // Use logger.* instead of console.* - NO exceptions
    'no-var': 'error',
    'prefer-const': 'error',
    'object-shorthand': 'error',

    // TypeScript specific rules
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',

    // Logging rules - enforce global logger usage
    'no-restricted-syntax': [
      'error',
      {
        selector:
          'Decorator[expression.callee.name="inject"][expression.arguments.0.property.name="Logger"]',
        message: 'Use global logger import instead of DI: import { logger } from "@infra/logging"',
      },
      {
        selector: 'CallExpression[callee.name="inject"][arguments.0.property.name="Logger"]',
        message: 'Use global logger import instead of DI: import { logger } from "@infra/logging"',
      },
    ],

    // Allow duplicate imports (needed for barrel exports)
    'no-duplicate-imports': 'off',

    // Allow control characters in regex (for ANSI codes in tests)
    'no-control-regex': 'off',
  },
  overrides: [
    {
      files: ['test/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unused-vars': 'off',
        'no-console': 'off', // Allow console in tests
        'no-restricted-syntax': 'off', // Allow DI in tests
      },
    },
    {
      files: ['scripts/**/*.mjs'],
      parser: 'espree',
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      env: {
        node: true,
        es2022: true,
      },
      rules: {
        '@typescript-eslint/no-unused-vars': 'off',
        'no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
        ],
        'no-console': 'off', // Allow console in build scripts
        'no-restricted-syntax': 'off', // Allow any syntax in build scripts
      },
    },
    {
      files: ['**/*.yml', '**/*.yaml'],
      parser: 'yaml-eslint-parser',
      extends: ['plugin:yml/standard'],
      rules: {
        'yml/no-empty-document': 'error',
        'yml/no-irregular-whitespace': 'error',
        'yml/plain-scalar': 'off',
        'yml/quotes': ['error', { prefer: 'single', avoidEscape: true }],
      },
    },
  ],
  ignorePatterns: ['dist/', 'node_modules/', 'archifiltre'],
};
