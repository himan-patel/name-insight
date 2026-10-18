// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/', 'node_modules/', 'coverage/'] },
    eslint.configs.recommended,
    tseslint.configs.recommended,
    {
        files: ['app/**/*.ts', 'test/**/*.ts'],
        rules: {
            curly: 'error',
            eqeqeq: ['error', 'smart'],
            'no-var': 'error',
            'prefer-const': 'error',
            // Express error handlers must declare all four parameters
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-require-imports': 'error'
        }
    }
);
