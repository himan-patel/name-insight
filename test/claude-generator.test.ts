import Anthropic from '@anthropic-ai/sdk';

import { ClaudeClient, createClaudeGenerator } from '../app/core/claude-generator';
import { SuggestionsFailedError, SuggestionsUnavailableError } from '../app/core/suggestions';

const request = { description: 'a coffee subscription', count: 3, tlds: ['com'], style: 'any' as const };

function fakeClient(parse: jest.Mock): ClaudeClient {
    return { beta: { messages: { parse } } } as unknown as ClaudeClient;
}

describe('createClaudeGenerator', () => {
    it('calls the Messages API with structured output, explicit effort and refusal fallbacks', async () => {
        const parse = jest.fn(async () => ({ stop_reason: 'end_turn', parsed_output: { names: [{ name: 'brewly', rationale: 'r' }] } }));
        const ideas = await createClaudeGenerator(fakeClient(parse))(request);

        expect(ideas).toEqual([{ name: 'brewly', rationale: 'r' }]);
        const params = (parse.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
        expect(params).toMatchObject({
            model: 'claude-opus-5-5',
            max_tokens: 4000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            output_config: { effort: 'medium' }
        });
        expect((params.output_config as { format: { type: string } }).format.type).toBe('json_schema');
        expect(JSON.stringify(params.messages)).toContain('<business_description>');
    });

    it('reports a refusal as a failed suggestion', async () => {
        const parse = jest.fn(async () => ({ stop_reason: 'refusal', parsed_output: null }));
        await expect(createClaudeGenerator(fakeClient(parse))(request)).rejects.toThrow('declined');
    });

    it('reports empty output', async () => {
        const parse = jest.fn(async () => ({ stop_reason: 'end_turn', parsed_output: { names: [] } }));
        await expect(createClaudeGenerator(fakeClient(parse))(request)).rejects.toThrow(SuggestionsFailedError);
    });

    it('maps bad credentials to "unavailable" without exposing details', async () => {
        const parse = jest.fn(async () => {
            throw new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers());
        });
        const error = await createClaudeGenerator(fakeClient(parse))(request).catch(e => e);
        expect(error).toBeInstanceOf(SuggestionsUnavailableError);
        expect(error.message).toBe('AI suggestions are temporarily unavailable');
    });

    it('maps rate limits and other API failures to a retryable 502', async () => {
        const rateLimited = jest.fn(async () => {
            throw new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', new Headers());
        });
        const error = await createClaudeGenerator(fakeClient(rateLimited))(request).catch(e => e);
        expect(error).toMatchObject({ status: 502, message: 'The AI service is busy; please try again shortly' });

        const broken = jest.fn(async () => { throw new Error('socket hang up'); });
        await expect(createClaudeGenerator(fakeClient(broken))(request)).rejects.toMatchObject({ status: 502 });
    });

    it('is unavailable without a client when no API key is configured', async () => {
        await expect(createClaudeGenerator()(request)).rejects.toBeInstanceOf(SuggestionsUnavailableError);
    });
});
