// Tests must never reach the network: outbound HTTP (RDAP, bootstrap) fails unless a test mocks it.
// Tests for the HTTP client itself use jest.requireActual.
jest.mock('../app/core/http-client', () => ({
    ...jest.requireActual('../app/core/http-client'),
    getJson: jest.fn(async (url: string) => {
        throw new Error(`network access is disabled in tests (attempted ${url})`);
    })
}));
