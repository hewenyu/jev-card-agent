import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import hooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'data/**',
      'test-results/**',
      'playwright-report/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      'max-lines': ['error', { max: 1000, skipBlankLines: false, skipComments: false }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': hooks },
    rules: hooks.configs.recommended.rules,
  },
  prettier,
);
