/** @type {import('jest').Config} */
module.exports = {
    testEnvironment: 'node',
    roots: ['<rootDir>/test'],
    transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }]
    },
    setupFiles: ['<rootDir>/test/setup-env.ts'],
    setupFilesAfterEnv: ['<rootDir>/test/setup-mocks.ts'],
    collectCoverageFrom: ['app/**/*.ts', '!app/index.ts'],
    clearMocks: true,
    restoreMocks: true
};
