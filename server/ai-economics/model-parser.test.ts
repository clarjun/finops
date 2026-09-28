/**
 * Every string in this file is a REAL charge description or service name taken
 * from the tenant's fact store, not an invented example. A parser tested
 * against imagined data passes and then fails on the first real invoice.
 */
import { describe, it, expect } from 'vitest';
import { parseAiUsage, tokenAvailabilityNote, type AiUsageRow } from './model-parser';

const aws = (serviceName: string, over: Partial<AiUsageRow> = {}): AiUsageRow => ({
  provider: 'aws', serviceName, chargeDescription: null, pricingUnit: 'N/A', ...over,
});

const gcp = (chargeDescription: string, over: Partial<AiUsageRow> = {}): AiUsageRow => ({
  provider: 'gcp', serviceName: 'Vertex AI', chargeDescription, pricingUnit: 'requests', ...over,
});

describe('AWS Bedrock — the model is in service_name', () => {
  it('reads model and version from the real service name', () => {
    const u = parseAiUsage(aws('Claude Opus 4.8 (Amazon Bedrock Edition)'))!;
    expect(u.vendor).toBe('anthropic');
    expect(u.model).toBe('Claude Opus 4.8');
    expect(u.family).toBe('Claude Opus');
    expect(u.isInference).toBe(true);
  });

  it('handles every Claude naming shape present in the data', () => {
    expect(parseAiUsage(aws('Claude Sonnet 4.6 (Amazon Bedrock Edition)'))!.model).toBe('Claude Sonnet 4.6');
    expect(parseAiUsage(aws('Claude Haiku 4.5 (Amazon Bedrock Edition)'))!.model).toBe('Claude Haiku 4.5');
    expect(parseAiUsage(aws('Claude Opus 5 (Amazon Bedrock Edition)'))!.model).toBe('Claude Opus 5');
    // Version BEFORE tier — the older naming convention, still in the data.
    expect(parseAiUsage(aws('Claude 3 Haiku (Amazon Bedrock Edition)'))!.model).toBe('Claude Haiku 3');
    expect(parseAiUsage(aws('Claude 3.7 Sonnet (Amazon Bedrock Edition)'))!.model).toBe('Claude Sonnet 3.7');
  });

  it('does NOT invent a token count', () => {
    // The central honesty rule. Bedrock's pricing_quantity is a fractional
    // number in an undocumented unit — 198.075 for $1,102. Dividing cost by it
    // would produce a precise, plausible, wrong cost-per-token.
    const u = parseAiUsage(aws('Claude Opus 4.8 (Amazon Bedrock Edition)', { pricingQuantity: 198.075 }))!;
    expect(u.tokens).toBeNull();
  });

  it('groups versions into one family for trending', () => {
    const versions = ['Claude Opus 4.6', 'Claude Opus 4.8', 'Claude Opus 5']
      .map(v => parseAiUsage(aws(`${v} (Amazon Bedrock Edition)`))!.family);
    expect(new Set(versions).size).toBe(1);
  });

  it('separates platform spend from model inference', () => {
    // SageMaker in a cost-per-token denominator would make a training cluster
    // inflate the reported price of a Claude call.
    const sm = parseAiUsage(aws('Amazon SageMaker'))!;
    expect(sm.isInference).toBe(false);
    expect(sm.tokens).toBeNull();
  });

  it('recognises generic Bedrock spend without claiming a model', () => {
    const u = parseAiUsage(aws('Amazon Bedrock'));
    // No model in the name and not a platform service: nothing to report.
    expect(u).toBeNull();
  });
});

describe('GCP Vertex — the model is in charge_description', () => {
  it('reads model, direction and real token counts', () => {
    // Verified against list price: 461,280 output tokens at $1.153197 is
    // exactly $2.50/1M, Gemini 2.5 Flash's published output rate.
    const u = parseAiUsage(gcp(
      'Generate content output token count gemini 2.5 flash short input text',
      { pricingQuantity: 461280 },
    ))!;
    expect(u.vendor).toBe('google');
    expect(u.model).toBe('Gemini 2.5 Flash');
    expect(u.direction).toBe('output');
    expect(u.tokens).toBe(461280);
  });

  it('reads input direction', () => {
    const u = parseAiUsage(gcp(
      'Generate content input token count gemini 2.5 flash short input text',
      { pricingQuantity: 1983966 },
    ))!;
    expect(u.direction).toBe('input');
    expect(u.tokens).toBe(1983966);
  });

  it('parses the "- Predictions" naming shape too', () => {
    const u = parseAiUsage(gcp('Gemini 2.5 Pro Thinking Text Output - Predictions'))!;
    expect(u.model).toBe('Gemini 2.5 Pro');
    expect(u.direction).toBe('output');
    expect(u.modality).toBe('text');
  });

  it('distinguishes cache charges from ordinary input', () => {
    // Priced very differently; folding them together distorts input cost.
    const u = parseAiUsage(gcp(' Gemini 2.5 Flash GA Input Text Caching (Long)'))!;
    expect(u.direction).toBe('cache');
  });

  it('reads modality', () => {
    expect(parseAiUsage(gcp('Gemini 2.5 Flash GA Audio Input (Long) - Predictions'))!.modality).toBe('audio');
    expect(parseAiUsage(gcp('Gemini 3.5 Flash Global Text Input - Predictions'))!.modality).toBe('text');
  });

  it('handles Flash Lite as its own model, not Flash', () => {
    // Materially different price; collapsing them would misreport both.
    const u = parseAiUsage(gcp(
      'Generate content output token count gemini 2.5 flash lite short output text non-thinking',
    ))!;
    expect(u.model).toBe('Gemini 2.5 Flash Lite');
  });

  it('picks up newer versions without a code change', () => {
    // Versions are captured, not enumerated. A hard-coded list would leave the
    // newest and most expensive model reporting as unknown.
    expect(parseAiUsage(gcp('Gemini 3.7 Flash Global Text Output - Predictions'))!.model).toBe('Gemini 3.7 Flash');
    expect(parseAiUsage(gcp('Generate content input token count gemini 3.5 flash text'))!.model).toBe('Gemini 3.5 Flash');
  });

  it('does not treat a non-token row as tokens', () => {
    // GCP labels pricing_unit "requests" even on real token rows, so the unit
    // field cannot be the test — the description must say "token count".
    const u = parseAiUsage(gcp('Gemini 2.5 Flash GA Text Output (Thinking On) - Predictions', { pricingQuantity: 5000 }))!;
    expect(u.tokens).toBeNull();
  });
});

describe('other vendors', () => {
  it('recognises the models that appear on Bedrock and Vertex marketplaces', () => {
    expect(parseAiUsage(aws('Llama 3.1 70B'))!.vendor).toBe('meta');
    expect(parseAiUsage(aws('Mistral Large'))!.vendor).toBe('mistral');
    expect(parseAiUsage(aws('Amazon Nova Pro'))!.vendor).toBe('amazon');
    expect(parseAiUsage(aws('Command R+'))!.vendor).toBe('cohere');
    expect(parseAiUsage(aws('gpt-4o-mini'))!.vendor).toBe('openai');
  });
});

describe('not AI spend', () => {
  it('returns null so ordinary infrastructure is never counted as AI', () => {
    expect(parseAiUsage(aws('Amazon EC2'))).toBeNull();
    expect(parseAiUsage(aws('Amazon S3'))).toBeNull();
    expect(parseAiUsage({ provider: 'aws', serviceName: '', chargeDescription: null })).toBeNull();
  });

  it('survives odd input without throwing', () => {
    expect(() => parseAiUsage(aws('   '))).not.toThrow();
    expect(() => parseAiUsage(gcp('', { pricingQuantity: null }))).not.toThrow();
  });
});

describe('token availability note', () => {
  it('explains WHY AWS has no token counts, and what to do', () => {
    // "Token metrics unavailable" alone reads as a bug in our product.
    const note = tokenAvailabilityNote('aws');
    expect(note).toMatch(/Cost and Usage Report|invocation-log/i);
  });

  it('has something to say for every provider', () => {
    for (const p of ['aws', 'azure', 'gcp', 'weird']) {
      expect(tokenAvailabilityNote(p).length).toBeGreaterThan(20);
    }
  });
});
