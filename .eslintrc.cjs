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
    'no-console': 'off', // CLI tool needs console output
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
