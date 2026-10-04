// ESLint — the "catch real bugs" layer, not a style checker.
//
// TypeScript already covers types, and this codebase has a consistent voice
// that a formatter would flatten. So the rule set below is deliberately small:
// every rule here is one that catches a DEFECT, and anything that would merely
// produce churn is off.
//
// The reasoning behind that is practical. 310 source files were written before
// any linter existed, so a maximal preset reports thousands of findings, nobody
// fixes them, and the lint step becomes a thing people pass with `--no-verify`.
// A short list that is genuinely green is worth more than a long one that is
// permanently red.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    // Build output, dependencies, and generated files. Linting dist/ reports
    // thousands of findings about code nobody wrote.
    ignores: [
      'dist/**',
      'node_modules/**',
      '.local/**',
      'server/python/**',
      '**/*.d.ts',
      'client/src/components/ui/**',   // shadcn/ui, vendored verbatim

      // 26 ad-hoc CommonJS debug scripts live at the repository root
      // (test-azure-auth.cjs, debug-budget-vs-dropdown.cjs, and so on). They
      // are run by hand, are not imported by anything, and are not part of the
      // build. They accounted for essentially every error in the first
      // measurement; linting them would mean the lint step reports on code
      // nobody maintains. They are left in place, just not gated on.
      '*.cjs',
      'postcss.config.js',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // ── Off: TypeScript already enforces these, better ────────────────────

      // typescript-eslint documents this one as required-off for TS files, and
      // the measurement agrees: 723 of 774 findings were this rule alone. It
      // does not understand TS types, interfaces or ambient globals, so it
      // reports them all as undefined. The compiler already catches a genuinely
      // undefined identifier, with a better message.
      'no-undef': 'off',

      '@typescript-eslint/no-explicit-any': 'off',
      // `any` is used deliberately at provider boundaries, where the shape is
      // whatever AWS/Azure/GCP returned and narrowing happens explicitly.

      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',

      // ── Warn: worth seeing, not worth blocking a deploy ───────────────────
      '@typescript-eslint/no-unused-vars': ['warn', {
        // An unused parameter prefixed with _ is an intentional signature
        // placeholder — Express handlers take (req, res, next) whether or not
        // they use all three.
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],

      // ── Error: each of these is a bug, not a preference ───────────────────

      // `if (x = 1)` — assignment where a comparison was meant.
      'no-cond-assign': 'error',

      // A duplicate key silently discards the first value. In a config object
      // or a Terraform mapper that is a wrong deployment, not a typo.
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-duplicate-case': 'error',

      // Code after return/throw never runs. Usually a bad merge.
      'no-unreachable': 'error',

      // `await` inside a loop condition, comparisons against NaN, and the
      // classic `typeof x === 'strnig'`.
      'use-isnan': 'error',
      'valid-typeof': 'error',

      // A promise rejection nobody handles crashes the process in Node 20+.
      'no-async-promise-executor': 'error',

      // `return` inside finally discards the exception being thrown.
      'no-unsafe-finally': 'error',

      // Left in by accident; stops the world in production.
      'no-debugger': 'error',
    },
  },

  {
    // Build configuration files. Tailwind loads its plugins with require(),
    // which is the documented way to do it, and these files are executed by
    // their own tooling rather than bundled.
    files: ['*.config.ts', '*.config.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  {
    // Tests mock freely and assert on shapes that are not worth typing.
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.itest.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
);
