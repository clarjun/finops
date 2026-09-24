/**
 * Intent detection for the natural-language "Ask Anything" cost assistant.
 *
 * These pin a relevance bug: the action regexes used bare word boundaries
 * (\borphan\b, \bwaste\b), so they matched only the exact stems and silently
 * missed the inflected forms users actually type. "Show me orphaned volumes" —
 * the canonical query in this repo's own manual test script — classified as a
 * generic `list` instead of `find-orphaned`, and "wasteful/wasted resources"
 * never even set needsResourceData, so an idle question was answered with no
 * resource data at all. The fix matches orphan\w* / wast\w*.
 */
import { describe, it, expect } from 'vitest';
import { analyzeQuery } from './query-analyzer';

describe('analyzeQuery — action detection across inflections', () => {
  it('classifies every orphan inflection as find-orphaned', () => {
    for (const q of [
      'show me orphan volumes',
      'show me orphaned storage volumes',
      'list orphans',
      'any unattached disks?',
    ]) {
      const intent = analyzeQuery(q);
      expect(intent.action, q).toBe('find-orphaned');
      expect(intent.needsResourceData, q).toBe(true);
    }
  });

  it('classifies every waste/idle inflection as find-idle and flags needsResourceData', () => {
    for (const q of [
      'where am I wasting money',
      'show me wasted spend',
      'find my wasteful resources',
      'which resources are idle',
      'find underutilized instances',
    ]) {
      const intent = analyzeQuery(q);
      expect(intent.action, q).toBe('find-idle');
      expect(intent.needsResourceData, q).toBe(true);
    }
  });

  it('treats plain cost questions as cost-only (no resource fetch)', () => {
    for (const q of [
      'what is my top cost driver?',
      "what's the trend this month?",
      'which services cost the most?',
    ]) {
      const intent = analyzeQuery(q);
      expect(intent.needsResourceData, q).toBe(false);
    }
  });

  it('infers AWS from resource nouns even without the word "aws"', () => {
    expect(analyzeQuery('find idle ec2 instances').provider).toBe('aws');
    expect(analyzeQuery('show me my s3 buckets').resourceTypes).toContain('storage');
  });

  it('parses age filters and normalizes units to days', () => {
    expect(analyzeQuery('orphaned disks older than 60 days').filters?.age).toBe(60);
    expect(analyzeQuery('idle vms older than 2 weeks').filters?.age).toBe(14);
    expect(analyzeQuery('unattached volumes older than 3 months').filters?.age).toBe(90);
  });
});
