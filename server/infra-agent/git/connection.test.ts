import { describe, it, expect } from 'vitest';
import { parseRepo } from './connection';
import { GitProviderError } from './types';

describe('parseRepo', () => {
  it('accepts the plain form', () => {
    expect(parseRepo('cirruslabs/cloudwise-infra')).toEqual({ owner: 'cirruslabs', repo: 'cloudwise-infra' });
  });

  it('tolerates what people actually paste', () => {
    // Operators copy the browser URL, not the owner/repo pair. Rejecting that
    // is a pointless obstacle when the intent is unambiguous.
    const expected = { owner: 'cirruslabs', repo: 'cloudwise-infra' };
    expect(parseRepo('https://github.com/cirruslabs/cloudwise-infra')).toEqual(expected);
    expect(parseRepo('https://github.com/cirruslabs/cloudwise-infra.git')).toEqual(expected);
    expect(parseRepo('  cirruslabs/cloudwise-infra/  ')).toEqual(expected);
  });

  it('refuses anything ambiguous rather than guessing', () => {
    expect(() => parseRepo('cloudwise-infra')).toThrow(GitProviderError);
    expect(() => parseRepo('a/b/c')).toThrow(GitProviderError);
    expect(() => parseRepo('')).toThrow(GitProviderError);
    expect(() => parseRepo('/')).toThrow(GitProviderError);
  });

  it('rejects characters that are not valid in a repository path', () => {
    // These end up in a URL path. Refusing here keeps anything odd out of the
    // request rather than relying on encoding downstream.
    expect(() => parseRepo('acme/repo?x=1')).toThrow(GitProviderError);
    expect(() => parseRepo('acme/../etc')).toThrow(GitProviderError);
    expect(() => parseRepo('acme/repo name')).toThrow(GitProviderError);
  });

  it('explains how to fix it', () => {
    // A validation error that does not show the expected form just produces a
    // second failed attempt.
    expect(() => parseRepo('nope')).toThrow(/owner\/repo/);
  });
});
