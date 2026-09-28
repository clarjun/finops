/**
 * Every model id and usage type here is real — taken from this tenant's
 * CloudWatch metrics and from live AWS Price List responses.
 */
import { describe, it, expect } from 'vitest';
import { modelIdSignature, normalizeName, matchModel, bestMatch } from './matching';

describe('modelIdSignature', () => {
  it('strips vendor, build date and version from a real Bedrock id', () => {
    expect(modelIdSignature('anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('claudehaiku45');
    expect(modelIdSignature('anthropic.claude-sonnet-4-6')).toBe('claudesonnet46');
    expect(modelIdSignature('amazon.titan-embed-text-v2:0')).toBe('titanembedtext');
  });

  it('ignores the routing profile prefix', () => {
    // Same model, three routings, one signature — otherwise each would need
    // its own rate.
    const ids = [
      'anthropic.claude-haiku-4-5-20251001-v1:0',
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    ].map(modelIdSignature);
    expect(new Set(ids).size).toBe(1);
  });

  it('keeps version digits', () => {
    // The difference between a $0.25 model and a $15 one.
    expect(modelIdSignature('anthropic.claude-haiku-4-5')).not.toBe(modelIdSignature('anthropic.claude-opus-4-5'));
    expect(modelIdSignature('anthropic.claude-sonnet-4-5')).not.toBe(modelIdSignature('anthropic.claude-sonnet-4-6'));
  });

  it('survives an unexpected shape', () => {
    expect(() => modelIdSignature('')).not.toThrow();
    expect(() => modelIdSignature('weird')).not.toThrow();
  });
});

describe('normalizeName', () => {
  it('converges the spellings the two sides use', () => {
    // "Claude 3 Sonnet" (Price List), "claude-3-sonnet" (API), "Claude3Sonnet"
    // (usage type) are the same model.
    const forms = ['Claude 3 Sonnet', 'claude-3-sonnet', 'Claude3Sonnet'].map(normalizeName);
    expect(new Set(forms).size).toBe(1);
  });
});

describe('matching a metered model to a published rate', () => {
  it('matches exactly when the usage type embeds the API model id', () => {
    // How newer Bedrock entries are named — unambiguous.
    const m = matchModel('zai.glm-4.7', { usageType: 'USE1-zai.glm-4.7-output-tokens-batch' });
    expect(m.strength).toBe('exact');
  });

  it('matches the squashed form older entries use', () => {
    const m = matchModel('anthropic.claude-3-sonnet-20240229-v1:0', {
      usageType: 'USE1-Claude3Sonnet-input-tokens', modelLabel: 'Claude 3 Sonnet',
    });
    expect(m.strength).not.toBe('none');
  });

  it('matches on the display label', () => {
    expect(matchModel('anthropic.claude-3-haiku-20240307-v1:0', { modelLabel: 'Claude 3 Haiku' }).strength)
      .toBe('strong');
  });

  it('REFUSES to match a different version', () => {
    // The failure that matters. Attaching Haiku's rate to Opus usage is wrong
    // by roughly forty times and looks entirely plausible on a dashboard.
    expect(matchModel('anthropic.claude-opus-4-5', { modelLabel: 'Claude Haiku 4.5' }).strength).toBe('none');
    expect(matchModel('anthropic.claude-sonnet-4-6', { modelLabel: 'Claude Sonnet 4.5' }).strength).toBe('none');
  });

  it('refuses a bare family name', () => {
    // "Claude" must never match "Claude Opus 4.5".
    expect(matchModel('anthropic.claude-opus-4-5', { modelLabel: 'Claude' }).strength).toBe('none');
  });

  it('refuses when nothing is comparable', () => {
    expect(matchModel('anthropic.claude-sonnet-4-6', { modelLabel: 'Amazon Titan Text' }).strength).toBe('none');
    expect(matchModel('', { modelLabel: 'Claude 3 Sonnet' }).strength).toBe('none');
  });

  it('always explains itself', () => {
    // The reason is shown when a customer asks where a rate came from.
    expect(matchModel('anthropic.claude-sonnet-4-6', { modelLabel: 'Nova Pro' }).reason.length).toBeGreaterThan(10);
  });
});

describe('bestMatch', () => {
  it('prefers an exact match over a strong one', () => {
    const result = bestMatch('zai.glm-4.7', [
      { usageType: 'USE1-GLM47-input-tokens', modelLabel: 'GLM 4.7' },
      { usageType: 'USE1-zai.glm-4.7-input-tokens' },
    ]);
    expect(result?.match.strength).toBe('exact');
  });

  it('returns null when two different candidates match equally', () => {
    // Genuine ambiguity. Picking one at random is exactly the silent error
    // this module exists to prevent.
    const result = bestMatch('anthropic.claude-3-sonnet-20240229-v1:0', [
      { usageType: 'USE1-Claude3Sonnet-input-tokens' },
      { usageType: 'USE1-Claude3Sonnet-provisioned' },
    ]);
    expect(result).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(bestMatch('anthropic.claude-sonnet-4-6', [{ modelLabel: 'Nova Pro' }])).toBeNull();
    expect(bestMatch('anthropic.claude-sonnet-4-6', [])).toBeNull();
  });

  it('tolerates duplicates of the same candidate', () => {
    // Several regions return the same usage type; that is not ambiguity.
    const result = bestMatch('zai.glm-4.7', [
      { usageType: 'USE1-zai.glm-4.7-input-tokens' },
      { usageType: 'USE1-zai.glm-4.7-input-tokens' },
    ]);
    expect(result).not.toBeNull();
  });
});
