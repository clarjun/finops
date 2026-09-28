/**
 * The classification is the whole point of the coverage view, so it is the part
 * worth testing directly: get it wrong and the page confidently mislabels
 * $12,944 of Marketplace spend as metered.
 */
import { describe, it, expect } from 'vitest';
import { classify } from './coverage';

describe('classify', () => {
  it('treats Marketplace editions as unmeterable even when metrics exist', () => {
    // The critical case. "Claude Sonnet 4.6 (Amazon Bedrock Edition)" and the
    // metered id `us.anthropic.claude-sonnet-4-6` normalise to the same string,
    // so a name-based matcher would claim this spend was measured. It was not:
    // the Marketplace path emits no InvokeModel call.
    const r = classify('Claude Sonnet 4.6 (Amazon Bedrock Edition)', true);
    expect(r.status).toBe('marketplace');
    expect(r.remedy).toMatch(/Anthropic/i);
  });

  it.each([
    'Claude Opus 4.8 (Amazon Bedrock Edition)',
    'Claude 3 Haiku (Amazon Bedrock Edition)',
    'Claude Opus 5 (Amazon Bedrock Edition)',
  ])('classifies %s as marketplace', (name) => {
    expect(classify(name, false).status).toBe('marketplace');
  });

  it('marks the Bedrock inference API as metered when metrics are present', () => {
    expect(classify('Amazon Bedrock', true).status).toBe('metered');
  });

  it('marks the Bedrock inference API as collectable, not hopeless, when no metrics exist', () => {
    const r = classify('Amazon Bedrock', false);
    expect(r.status).toBe('no_telemetry');
    expect(r.remedy).toMatch(/Collect usage/i);
  });

  it('separates platform charges that have no token dimension at all', () => {
    for (const name of ['Amazon SageMaker', 'Amazon Comprehend', 'Amazon Textract']) {
      const r = classify(name, false);
      expect(r.status).toBe('platform');
      expect(r.remedy).toBeNull();   // nothing the customer can do; do not imply otherwise
    }
  });

  it('does not let a platform service be called metered by a stray metric', () => {
    // SageMaker precedes the hasMetrics branch on purpose: endpoint-hours are
    // not tokens no matter what else was collected in the window.
    expect(classify('Amazon SageMaker', true).status).toBe('platform');
  });

  it('gives an unrecognised AI service an honest status rather than guessing', () => {
    const r = classify('Kiro', false);
    expect(r.status).toBe('no_telemetry');
    expect(r.remedy).toBeNull();
  });

  it('always explains itself', () => {
    for (const name of ['Amazon Bedrock', 'Claude Opus 5 (Amazon Bedrock Edition)', 'Amazon SageMaker', 'Kiro']) {
      expect(classify(name, false).reason.length).toBeGreaterThan(20);
    }
  });
});
