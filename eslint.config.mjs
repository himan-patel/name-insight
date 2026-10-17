// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/', 'node_modules/'] },
    eslint.configs.recommended,
    tseslint.configs.recommended,
    {
        files: ['app/**/*.ts'],
        rules: {
            curly: 'error',
            eqeqeq: ['error', 'smart'],
            'no-var': 'error',
            'prefer-const': 'error',
            // Express error handlers must declare all four parameters
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            // existing code relies on these; tighten as part of enabling strict mode
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-require-imports': 'warn'
        }
    }
);
