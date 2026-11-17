import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Purity rules for the functional core. Anything nondeterministic
// or effectful belongs in an adapter and is passed in.
const corePurity = {
  'no-restricted-globals': [
    'error',
    ...['process', 'console', 'setTimeout', 'setInterval', 'fetch', 'crypto', 'Buffer'].map(
      (name) => ({
        name,
        message: 'core is pure: move effects to an adapter',
      }),
    ),
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: "NewExpression[callee.name='Date'][arguments.length=0]",
      message: 'core is pure: pass time in',
    },
    {
      selector: "MemberExpression[object.name='Date'][property.name='now']",
      message: 'core is pure: pass time in',
    },
    {
      selector: "MemberExpression[object.name='Math'][property.name='random']",
      message: 'core is deterministic',
    },
    {
      selector: 'Literal[raw=/^\\d*\\.\\d+$/]',
      message: 'money math is bigint: no float literals in core',
    },
  ],
};

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/gen/**',
      '**/node_modules/**',
      'tests/perf/**',
      'reports/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { project: ['./tsconfig.check.json'], tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 12],
    },
  },
  { files: ['packages/core/src/**/*.ts'], rules: corePurity },
  {
    files: ['**/test/**/*.ts', 'tests/**/*.ts'],
    rules: { 'max-lines': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    files: ['**/*.mjs', '**/*.cjs', 'vitest.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', module: 'writable' },
    },
  },
  prettier,
);
