/**
 * The clarification phase.
 *
 * Only questions that change the infrastructure get asked. Everything the
 * estimate already implies is inferred and shown as a default the user can
 * override, because an agent that re-asks what it was just told is not being
 * careful, it is being tedious — and each unnecessary question is another
 * chance for someone to abandon the flow.
 *
 * Deterministic by design: the same requirement produces the same questions.
 * A model deciding what to ask would vary between runs, and a clarification
 * flow that changes shape each time cannot be tested or documented.
 */
import type { Clarifications, EstimatorLayer, LamMetadata } from './types';

export interface ClarificationOption {
  value: string;
  label: string;
  description?: string;
  /** Rendered as pre-selected, with why it was inferred. */
  recommended?: boolean;
}

export interface ClarificationQuestion {
  id: keyof Clarifications | 'cloudAccountId';
  question: string;
  /** Why this question changes the build. Shown so it does not feel arbitrary. */
  rationale: string;
  type: 'choice' | 'account';
  options?: ClarificationOption[];
  /** Inferred answer, and how it was inferred. */
  inferred?: { value: string; because: string };
  required: boolean;
}

/** Availability implied by the requirement text. Mirrors the compiler's inference. */
export function inferAvailability(requirements: string): { value: LamMetadata['availability']; because: string } | null {
  const t = requirements.toLowerCase();
  if (/multi[- ]region|cross[- ]region/.test(t)) return { value: 'multi_region', because: 'the requirement mentions multi-region' };
  if (/multi[- ]az/.test(t)) return { value: 'multi_az', because: 'the requirement mentions multi-AZ' };
  if (/high availability|highly available|\bha\b/.test(t)) return { value: 'high', because: 'the requirement asks for high availability' };
  return null;
}

/** Region named in the requirement, e.g. "Region: us-east-1". */
export function inferRegion(requirements: string): { value: string; because: string } | null {
  const m = requirements.match(/\b((?:us|eu|ap|sa|ca|me|af)-[a-z]+-\d)\b/i);
  return m ? { value: m[1].toLowerCase(), because: `the requirement names ${m[1]}` } : null;
}

/** Environment named in the requirement. Defaults are deliberately not production. */
export function inferEnvironment(requirements: string): { value: LamMetadata['environment']; because: string } | null {
  const t = requirements.toLowerCase();
  if (/\bproduction\b|\bprod\b/.test(t)) return { value: 'production', because: 'the requirement mentions production' };
  if (/\bstaging\b|\buat\b/.test(t)) return { value: 'staging', because: 'the requirement mentions staging' };
  if (/\bdev(elopment)?\b/.test(t)) return { value: 'development', because: 'the requirement mentions development' };
  return null;
}

export function inferCompliance(requirements: string): { value: string[]; because: string } | null {
  const found = ['SOC2', 'HIPAA', 'PCI-DSS', 'GDPR', 'ISO27001']
    .filter((c) => new RegExp(c.replace('-', '[- ]?'), 'i').test(requirements));
  return found.length > 0 ? { value: found, because: `the requirement mentions ${found.join(', ')}` } : null;
}

/**
 * The questions still worth asking.
 *
 * `answered` lets this be called repeatedly as the user works through the flow;
 * anything already decided drops out.
 */
export function buildQuestions(
  requirements: string,
  _estimate: EstimatorLayer[],
  answered: Clarifications = {},
): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];

  // Cloud provider. Never inferred: the estimate is AWS-shaped because the
  // estimator only prices AWS, which is not evidence the user wants AWS.
  if (!answered.provider) {
    questions.push({
      id: 'provider',
      question: 'Which cloud should this be deployed to?',
      rationale: 'Determines every resource type, and the account the agent will act as.',
      type: 'choice',
      required: true,
      options: [
        { value: 'aws', label: 'AWS', description: 'Fully supported today' },
        { value: 'azure', label: 'Azure', description: 'Planning supported; resource mapping in progress' },
        { value: 'gcp', label: 'Google Cloud', description: 'Planning supported; resource mapping in progress' },
      ],
    });
  }

  // Which account. Cannot be inferred, and picking one would mean deploying
  // into an account nobody chose.
  if (!answered.cloudAccountId) {
    questions.push({
      id: 'cloudAccountId',
      question: 'Which connected account should it deploy into?',
      rationale: 'The agent deploys using this account’s stored credentials. Nothing is created anywhere else.',
      type: 'account',
      required: true,
    });
  }

  if (!answered.region) {
    const inferred = inferRegion(requirements);
    questions.push({
      id: 'region',
      question: 'Which region?',
      rationale: 'Affects price, latency and which services are available.',
      type: 'choice',
      required: true,
      inferred: inferred ?? undefined,
      options: [
        { value: 'us-east-1', label: 'us-east-1 (N. Virginia)', recommended: inferred?.value === 'us-east-1' },
        { value: 'us-west-2', label: 'us-west-2 (Oregon)', recommended: inferred?.value === 'us-west-2' },
        { value: 'eu-west-1', label: 'eu-west-1 (Ireland)', recommended: inferred?.value === 'eu-west-1' },
        { value: 'ap-south-1', label: 'ap-south-1 (Mumbai)', recommended: inferred?.value === 'ap-south-1' },
      ],
    });
  }

  if (!answered.environment) {
    const inferred = inferEnvironment(requirements);
    questions.push({
      id: 'environment',
      question: 'Which environment is this?',
      rationale: 'Production tightens defaults — longer backup retention, and approval required for more steps.',
      type: 'choice',
      required: true,
      // Defaults to development when unstated. Guessing production would make
      // the safer answer the one requiring a correction.
      inferred: inferred ?? { value: 'development', because: 'no environment was stated, so the least privileged is assumed' },
      options: [
        { value: 'development', label: 'Development' },
        { value: 'staging', label: 'Staging' },
        { value: 'production', label: 'Production', description: 'More approval gates, longer retention' },
      ],
    });
  }

  if (!answered.availability) {
    const inferred = inferAvailability(requirements);
    questions.push({
      id: 'availability',
      question: 'What availability does it need?',
      rationale: 'High availability doubles subnets and enables multi-AZ databases, which changes both cost and topology.',
      type: 'choice',
      required: true,
      inferred: inferred ?? { value: 'standard', because: 'the requirement does not mention availability' },
      options: [
        { value: 'standard', label: 'Standard', description: 'Single zone' },
        { value: 'high', label: 'High availability', description: 'Two zones', recommended: inferred?.value === 'high' },
        { value: 'multi_az', label: 'Multi-AZ', recommended: inferred?.value === 'multi_az' },
        { value: 'multi_region', label: 'Multi-region', description: 'Not yet supported by the AWS mapper', recommended: inferred?.value === 'multi_region' },
      ],
    });
  }

  if (!answered.compliance) {
    const inferred = inferCompliance(requirements);
    questions.push({
      id: 'compliance',
      question: 'Any compliance requirements?',
      rationale: 'Raises the risk level of data stores and key material, so more steps require approval.',
      type: 'choice',
      required: false,
      inferred: inferred ? { value: inferred.value.join(','), because: inferred.because } : undefined,
      options: [
        { value: '', label: 'None' },
        { value: 'SOC2', label: 'SOC 2' },
        { value: 'HIPAA', label: 'HIPAA' },
        { value: 'PCI-DSS', label: 'PCI-DSS' },
        { value: 'GDPR', label: 'GDPR' },
      ],
    });
  }

  return questions;
}

/** Applies inferred answers, so the user confirms rather than retypes. */
export function applyInferences(requirements: string, answered: Clarifications = {}): Clarifications {
  const result: Clarifications = { ...answered };
  if (!result.region) result.region = inferRegion(requirements)?.value;
  if (!result.environment) result.environment = inferEnvironment(requirements)?.value ?? 'development';
  if (!result.availability) result.availability = inferAvailability(requirements)?.value ?? 'standard';
  if (!result.compliance) result.compliance = inferCompliance(requirements)?.value ?? [];
  return result;
}
