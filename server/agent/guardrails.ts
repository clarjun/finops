/**
 * Execution guardrails.
 *
 * agent_config has carried autoExecuteEnabled, dryRunMode, safetyMode,
 * enabledProviders, enabledActionTypes, requireApprovalFor and
 * maxCostImpactWithoutApproval since the table was created. Nothing ever read
 * them. The executor hardcoded `dryRunMode = true` in a constructor default and
 * was exported as a singleton that no caller ever configured, so the settings
 * page wrote values that changed nothing — including the switch a customer would
 * use to say "never touch my production account".
 *
 * Every execution now passes through evaluate() first, and the decision is
 * recorded in the audit log whether it allows, downgrades to a simulation, or
 * blocks.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentConfig, type OptimizationAction } from "@shared/schema";
import { currentOrgId } from "../tenant-context";

/**
 * Action types that destroy state rather than resize or reconfigure it. These
 * cannot be undone by a rollback, so safetyMode blocks them outright.
 */
const DESTRUCTIVE_ACTION_TYPES = new Set([
  'ebs_delete_snapshot',
  'delete_snapshot',
  'delete_volume',
  'delete_bucket',
  'terminate_instance',
  'azure_delete_disk',
  'azure_delete_snapshot',
  'gcp_delete_disk',
  'gcp_delete_snapshot',
]);

export interface GuardrailDecision {
  /** allow: execute for real. simulate: run as a dry run. block: refuse. */
  outcome: 'allow' | 'simulate' | 'block';
  dryRun: boolean;
  reasons: string[];
  config: {
    dryRunMode: boolean;
    safetyMode: boolean;
    autoExecuteEnabled: boolean;
  };
}

/** The tenant's agent configuration, created with safe defaults on first use. */
export async function getAgentConfig() {
  const orgId = currentOrgId();

  const [existing] = await db.select().from(agentConfig)
    .where(eq(agentConfig.organizationId, orgId))
    .limit(1);
  if (existing) return existing;

  const [created] = await db.insert(agentConfig)
    .values({ organizationId: orgId, dryRunMode: 1, autoExecuteEnabled: 0, safetyMode: 1 })
    .returning();
  return created;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter((v): v is string => typeof v === 'string');
  return items.length > 0 ? items : null;
}

/** The subset of agent_config the decision depends on. */
export interface GuardrailConfig {
  dryRunMode: number | null;
  safetyMode: number | null;
  autoExecuteEnabled: number | null;
  enabledProviders: unknown;
  enabledActionTypes: unknown;
  requireApprovalFor: unknown;
  maxCostImpactWithoutApproval: string | null;
}

/**
 * Decide whether an action may execute.
 *
 * Pure: takes the config rather than reading it, so the rules can be tested
 * exhaustively without a database. evaluate() is the wrapper that loads config
 * for the current tenant.
 */
export function decide(
  action: Pick<OptimizationAction, 'provider' | 'actionType' | 'estimatedCostImpact' | 'approvedBy'>,
  config: GuardrailConfig,
): GuardrailDecision {
  const reasons: string[] = [];

  const dryRunMode = config.dryRunMode === 1;
  const safetyMode = config.safetyMode === 1;
  const autoExecuteEnabled = config.autoExecuteEnabled === 1;
  const snapshot = { dryRunMode, safetyMode, autoExecuteEnabled };

  // ── Hard blocks ───────────────────────────────────────────────────────────

  const enabledProviders = asStringArray(config.enabledProviders);
  if (enabledProviders && !enabledProviders.includes(action.provider)) {
    reasons.push(`Provider '${action.provider}' is not enabled for this organization.`);
    return { outcome: 'block', dryRun: true, reasons, config: snapshot };
  }

  const enabledActionTypes = asStringArray(config.enabledActionTypes);
  if (enabledActionTypes && !enabledActionTypes.includes(action.actionType)) {
    reasons.push(`Action type '${action.actionType}' is not in the enabled list.`);
    return { outcome: 'block', dryRun: true, reasons, config: snapshot };
  }

  if (safetyMode && DESTRUCTIVE_ACTION_TYPES.has(action.actionType)) {
    reasons.push(
      `Safety mode is on and '${action.actionType}' destroys data that a rollback cannot restore.`
    );
    return { outcome: 'block', dryRun: true, reasons, config: snapshot };
  }

  // Cost impact is a one-off charge (a purchase, an early-termination fee).
  // Above the configured ceiling it needs a human, not an automated run.
  const costImpact = action.estimatedCostImpact === null || action.estimatedCostImpact === undefined
    ? 0
    : Number(action.estimatedCostImpact);
  const ceiling = config.maxCostImpactWithoutApproval === null || config.maxCostImpactWithoutApproval === undefined
    ? null
    : Number(config.maxCostImpactWithoutApproval);

  if (ceiling !== null && costImpact > ceiling && !action.approvedBy) {
    reasons.push(
      `Cost impact $${costImpact.toFixed(2)} exceeds the $${ceiling.toFixed(2)} limit for unapproved actions.`
    );
    return { outcome: 'block', dryRun: true, reasons, config: snapshot };
  }

  const requireApprovalFor = asStringArray(config.requireApprovalFor);
  if (requireApprovalFor?.includes(action.actionType) && !action.approvedBy) {
    reasons.push(`'${action.actionType}' always requires named approval, and none is recorded.`);
    return { outcome: 'block', dryRun: true, reasons, config: snapshot };
  }

  // ── Downgrade to simulation ───────────────────────────────────────────────

  if (dryRunMode) {
    reasons.push('Dry-run mode is on: the change is simulated, not applied.');
    return { outcome: 'simulate', dryRun: true, reasons, config: snapshot };
  }

  reasons.push('Passed all guardrails; executing for real.');
  return { outcome: 'allow', dryRun: false, reasons, config: snapshot };
}

/**
 * Load the calling tenant's configuration and decide.
 *
 * Fails closed: if the config cannot be read at all, the action is simulated
 * rather than executed.
 */
export async function evaluate(action: OptimizationAction): Promise<GuardrailDecision> {
  let config;
  try {
    config = await getAgentConfig();
  } catch (err: any) {
    return {
      outcome: 'simulate',
      dryRun: true,
      reasons: [`Could not read agent configuration (${err?.message ?? err}); simulating instead of executing.`],
      config: { dryRunMode: true, safetyMode: true, autoExecuteEnabled: false },
    };
  }

  return decide(action, config);
}

export function isDestructive(actionType: string): boolean {
  return DESTRUCTIVE_ACTION_TYPES.has(actionType);
}
