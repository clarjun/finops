import { describe, it, expect } from 'vitest';
import { categorizeService } from './service-category';

describe('service categorization', () => {
  it('classifies the AWS names that billing data actually uses', () => {
    // These are real service names taken from Cost Explorer output. Several were
    // landing in "Other" because the rules used abbreviations (eks, kms, iam,
    // vpc, efs) that never appear in the spelled-out billing names.
    const cases: Array<[string, string]> = [
      ['Amazon Elastic Compute Cloud - Compute', 'Compute'],
      ['Amazon Elastic Container Service for Kubernetes', 'Compute'],
      ['Amazon Elastic Container Service', 'Compute'],
      ['Amazon Virtual Private Cloud', 'Networking'],
      ['AWS Key Management Service', 'Security'],
      ['AWS Identity and Access Management Access Analyzer', 'Security'],
      ['AWS Directory Service', 'Security'],
      ['Amazon OpenSearch Service', 'Analytics'],
      ['Amazon Elastic File System', 'Storage'],
      ['Amazon Simple Storage Service', 'Storage'],
      ['Amazon Relational Database Service', 'Databases'],
      ['AWS Cost Explorer', 'Management and Governance'],
      ['AWS Lambda', 'Compute'],
      ['Claude Opus 4.8 (Amazon Bedrock Edition)', 'AI and Machine Learning'],
    ];

    for (const [name, expected] of cases) {
      expect(categorizeService(name), `"${name}"`).toBe(expected);
    }
  });

  it('classifies GCP and Azure names onto the same axis', () => {
    // The point of categorizing at ingestion: cross-cloud comparison becomes a
    // GROUP BY instead of three service-name lists in the UI.
    expect(categorizeService('Compute Engine')).toBe('Compute');
    expect(categorizeService('Virtual Machines')).toBe('Compute');
    expect(categorizeService('Cloud Storage')).toBe('Storage');
    expect(categorizeService('Storage Account')).toBe('Storage');
    expect(categorizeService('Cloud SQL')).toBe('Databases');
    expect(categorizeService('Azure SQL Database')).toBe('Databases');
    expect(categorizeService('BigQuery')).toBe('Analytics');
    expect(categorizeService('Security Command Center')).toBe('Security');
    expect(categorizeService('Gemini API')).toBe('AI and Machine Learning');
  });

  it('puts identity services under Security, not Compute', () => {
    // Ordering regression guard: "AWS Directory Service" contains "service",
    // and an earlier Compute rule would swallow it.
    expect(categorizeService('AWS Directory Service')).toBe('Security');
    expect(categorizeService('Azure Active Directory')).toBe('Security');
  });

  it('falls back to Other rather than guessing', () => {
    expect(categorizeService('Some Brand New Service')).toBe('Other');
    expect(categorizeService('')).toBe('Other');
    expect(categorizeService(null)).toBe('Other');
    expect(categorizeService(undefined)).toBe('Other');
  });

  it('is case-insensitive', () => {
    expect(categorizeService('AMAZON ELASTIC COMPUTE CLOUD')).toBe('Compute');
    expect(categorizeService('bigquery')).toBe('Analytics');
  });

  it('returns a stable result when called repeatedly', () => {
    // The implementation memoizes; a mutable cache returning different answers
    // over time would make historical reports inconsistent.
    const first = categorizeService('Amazon Elastic Compute Cloud - Compute');
    for (let i = 0; i < 5; i++) {
      expect(categorizeService('Amazon Elastic Compute Cloud - Compute')).toBe(first);
    }
  });
});
