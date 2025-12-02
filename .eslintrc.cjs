module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'yml'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },

  // Global rules - strict for application code
  rules: {
    // Basic JavaScript/Node.js rules
    'no-console': 'error', // Force structured logging in app code
    'no-var': 'error',
    'prefer-const': 'error',
    'no-unused-vars': 'off', // Use TypeScript version instead
    'no-duplicate-imports': 'off', // Allow for re-exports
    'object-shorthand': 'error',
    'prefer-template': 'error',

    // TypeScript rules
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/prefer-as-const': 'error',
    '@typescript-eslint/no-non-null-assertion': 'warn',
    '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
  },

  overrides: [
    // Test files - more relaxed
    {
      files: ['test/**/*.ts', '**/*.spec.ts', '**/*.test.ts'],
      rules: {
        'no-console': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unused-vars': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/consistent-type-imports': 'off',
      },
    },

    // Script files - CLI tools need different rules
    {
      files: ['scripts/**/*.ts'],
      rules: {
        'no-console': 'off', // CLI tools need console output
        'no-process-exit': 'off', // Scripts often use process.exit()
        '@typescript-eslint/no-explicit-any': 'warn',
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/consistent-type-imports': 'off',
      },
    },

    // YAML configuration files
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

    // Configuration files - more lenient
    {
      files: ['*.config.ts', '*.config.js', '.eslintrc.cjs'],
      rules: {
        'no-console': 'off',
        '@typescript-eslint/no-var-requires': 'off',
      },
    },
  ],

  // Files and directories to ignore
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'archifiltre', // Your binary
    '*.min.js',
    'coverage/',
  ],
};
