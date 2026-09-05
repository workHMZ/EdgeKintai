import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    files: ['public/app.js', 'public/excel.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // excel.js carries a UMD tail so scripts/test-excel.mjs can load it
        // outside a browser.
        module: 'readonly',
      },
    },
    rules: {
      // The browser bundles ship unbuilt and unminified, so nothing downstream
      // reports an identifier that stopped being used. `no-unused-vars` is what
      // keeps a helper from outliving its last call site.
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { args: 'after-used', varsIgnorePattern: '^_' }],
      // Both bundles strip control characters out of untrusted text before it
      // reaches the DOM or an XLSX cell, so those ranges belong in the pattern.
      'no-control-regex': 'off',
      // Titles are typeset with U+3000 ideographic spaces, which is what the
      // rule flags inside template literals.
      'no-irregular-whitespace': ['error', { skipTemplates: true }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
];
