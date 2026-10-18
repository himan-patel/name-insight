// Public
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';

// Internal
import * as config from '../config/global.config';
import { errorMessage } from '../utils/async';
import { buildPrompt, NameGenerator, NameIdeasSchema, SuggestionsFailedError, SuggestionsUnavailableError } from './suggestions';

/** The subset of the Anthropic client this generator uses (lets tests pass a fake). */
export type ClaudeClient = Pick<Anthropic, 'beta'>;

let sharedClient: ClaudeClient | undefined;

/**
 * Name generator backed by the Claude API. The Anthropic SDK reads ANTHROPIC_API_KEY from the environment; the key is
 * never passed around, logged or returned by NameInsight.
 */
export function createClaudeGenerator(client?: ClaudeClient): NameGenerator {
    return async request => {
        if (!client && !config.claudeApiConfigured) {
            throw new SuggestionsUnavailableError();
        }
        const anthropic = client ?? (sharedClient ??= new Anthropic());
        const { system, user } = buildPrompt(request);

        let response;
        try {
            response = await anthropic.beta.messages.parse({
                model: config.aiModel,
                max_tokens: 4000,
                system,
                messages: [{ role: 'user', content: user }],
                output_config: { effort: config.aiEffort, format: betaZodOutputFormat(NameIdeasSchema) },
                // If the model declines, the API re-runs the request on a suitable fallback model
                betas: ['server-side-fallback-2026-07-01'],
                fallbacks: 'default'
            });
        } catch (error) {
            if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
                console.error('ClaudeGenerator :: Claude API rejected the configured credentials');
                throw new SuggestionsUnavailableError('AI suggestions are temporarily unavailable');
            }
            if (error instanceof Anthropic.RateLimitError) {
                throw new SuggestionsFailedError('The AI service is busy; please try again shortly', 502);
            }
            console.error(`ClaudeGenerator :: Claude API request failed: ${errorMessage(error)}`);
            throw new SuggestionsFailedError('The AI service failed to respond; please try again', 502);
        }

        if (response.stop_reason === 'refusal') {
            throw new SuggestionsFailedError('The model declined to suggest names for this description');
        }
        const ideas = response.parsed_output?.names;
        if (!ideas?.length) {
            throw new SuggestionsFailedError('The model did not return any names');
        }
        return ideas;
    };
}
