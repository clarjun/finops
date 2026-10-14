import { describe, it, expect } from 'vitest';
import { classifyAiError } from './ai-error';

/** The shape the OpenAI SDK throws. */
function apiError(status: number, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

describe('classifyAiError: configuration failures', () => {
  it('recognises the revoked-project key that broke production', () => {
    // The exact error, verbatim from the container logs. Every AI question for
    // a week answered "Please try again", which could never have worked.
    const failure = classifyAiError(
      apiError(401, '401 You do not have access to the project tied to the API key.', {
        type: 'invalid_request_error',
      }),
    );

    expect(failure.kind).toBe('config');
    expect(failure.retryable).toBe(false);
    expect(failure.message).toMatch(/administrator/i);
    expect(failure.message).not.toMatch(/try again\b(?!.*not)/i);
  });

  it('treats 401 and 403 as configuration regardless of wording', () => {
    for (const status of [401, 403]) {
      expect(classifyAiError(apiError(status, 'nope')).kind).toBe('config');
      expect(classifyAiError(apiError(status, 'nope')).retryable).toBe(false);
    }
  });

  it('recognises a missing or malformed key with no status attached', () => {
    expect(classifyAiError(new Error('The OPENAI_API_KEY environment variable is missing')).kind).toBe('config');
    expect(classifyAiError(new Error('Incorrect API key provided')).kind).toBe('config');
  });

  it('never echoes the provider error back to the user', () => {
    // The provider's text can contain a key fragment, an org id or an internal
    // URL. This surface is reached without authentication, so it says what to
    // do and nothing about what went wrong internally.
    const leaky = apiError(401, 'Invalid key sk-proj-ABC123SECRET for org org-9f3 at https://internal');
    const { message } = classifyAiError(leaky);
    expect(message).not.toContain('sk-proj');
    expect(message).not.toContain('org-9f3');
    expect(message).not.toContain('https://');
  });
});

describe('classifyAiError: quota and rate limits', () => {
  it('separates being out of credit from being throttled', () => {
    const broke = classifyAiError(apiError(429, 'You exceeded your current quota, please check your billing'));
    expect(broke.kind).toBe('quota');
    expect(broke.message).toMatch(/billing/i);

    const throttled = classifyAiError(apiError(429, 'Rate limit reached for requests'));
    expect(throttled.kind).toBe('quota');
    expect(throttled.message).toMatch(/wait a moment/i);
  });

  it('keeps both retryable', () => {
    expect(classifyAiError(apiError(429, 'rate limit')).retryable).toBe(true);
    expect(classifyAiError(apiError(429, 'quota')).retryable).toBe(true);
  });
});

describe('classifyAiError: upstream trouble', () => {
  it('treats provider 5xx and network drops as temporary', () => {
    for (const e of [
      apiError(500, 'internal server error'),
      apiError(503, 'overloaded'),
      new Error('socket hang up'),
      new Error('request timeout'),
    ]) {
      const f = classifyAiError(e);
      expect(f.kind).toBe('upstream');
      expect(f.retryable).toBe(true);
    }
  });
});

describe('classifyAiError: the unknown case', () => {
  it('assumes retryable, because a wrong "permanent" hides a transient fault', () => {
    const f = classifyAiError(new Error('something nobody anticipated'));
    expect(f.kind).toBe('unknown');
    expect(f.retryable).toBe(true);
    expect(f.status).toBe(500);
  });

  it('survives values that are not Errors at all', () => {
    for (const junk of [undefined, null, 'a string', 42, {}]) {
      expect(() => classifyAiError(junk)).not.toThrow();
      expect(classifyAiError(junk).retryable).toBe(true);
    }
  });
});
