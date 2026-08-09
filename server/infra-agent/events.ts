/**
 * The run event log.
 *
 * One append-only stream per run, serving three purposes at once: the audit
 * record of what the agent did, the live feed the deployment view renders, and
 * the replay source for a browser that reconnects mid-deployment.
 *
 * Because it is durable and sequenced, a client that disconnects for two minutes
 * resumes exactly where it left off. An in-memory feed would simply have lost
 * everything that happened while it was away — which, during a ten-minute
 * deployment, is the part the user most wanted to see.
 */
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { db } from '../db';
import { infraEvents } from '@shared/schema';
import { currentOrgId } from '../tenant-context';

export const INFRA_EVENT_TYPES = [
  'AGENT_STARTED',
  'REQUIREMENT_ANALYZED',
  'QUESTION_ASKED',
  'QUESTION_ANSWERED',
  'ARCHITECTURE_GENERATED',
  'DOCUMENTATION_RETRIEVED',
  'PLAN_CREATED',
  'PLAN_VALIDATED',
  'APPROVAL_REQUIRED',
  'APPROVED',
  'REJECTED',
  'RESOURCE_CREATING',
  'RESOURCE_CREATED',
  'RESOURCE_FAILED',
  'RETRY_STARTED',
  'DEPLOYMENT_COMPLETED',
  'DEPLOYMENT_FAILED',
  'KNOWLEDGE_SAVED',
  'RUN_PAUSED',
  'RUN_RESUMED',
] as const;

export type InfraEventType = (typeof INFRA_EVENT_TYPES)[number];

export interface AppendEventInput {
  runId: number;
  eventType: InfraEventType;
  message: string;
  nodeKey?: string | null;
  level?: 'info' | 'warn' | 'error';
  data?: unknown;
}

/** In-process subscribers, so an SSE client sees an event without polling. */
type Listener = (event: InfraEventRow) => void;
const listeners = new Map<number, Set<Listener>>();

export interface InfraEventRow {
  id: number;
  runId: number;
  eventType: string;
  nodeKey: string | null;
  level: string;
  message: string;
  data: unknown;
  sequence: number;
  createdAt: Date;
}

/**
 * Appends an event.
 *
 * The sequence is allocated inside the insert from the current maximum for the
 * run, so two workers appending concurrently cannot produce the same number —
 * computing it in application code first and inserting second would race, and a
 * duplicate sequence breaks the client's resume cursor.
 */
export async function appendEvent(input: AppendEventInput): Promise<InfraEventRow | null> {
  try {
    const organizationId = currentOrgId();

    const [row] = await db.insert(infraEvents).values({
      organizationId,
      runId: input.runId,
      eventType: input.eventType,
      nodeKey: input.nodeKey ?? null,
      level: input.level ?? 'info',
      message: input.message,
      data: (input.data ?? null) as never,
      sequence: sql`(select coalesce(max(e.sequence), 0) + 1 from infra_events e where e.run_id = ${input.runId})` as never,
    }).returning();

    const event = toRow(row);
    for (const l of listeners.get(input.runId) ?? []) {
      try {
        l(event);
      } catch {
        /* a failing subscriber must not break the run */
      }
    }
    return event;
  } catch (err) {
    // Losing an event must never fail the deployment that produced it. The run
    // still records its outcome in infra_runs and infra_run_nodes.
    console.error('[InfraEvents] Failed to append event:', (err as Error)?.message ?? err);
    return null;
  }
}

/** Events after `afterSequence`, for initial load and for replay on reconnect. */
export async function listEvents(runId: number, afterSequence = 0): Promise<InfraEventRow[]> {
  const rows = await db.select().from(infraEvents)
    .where(and(
      eq(infraEvents.organizationId, currentOrgId()),
      eq(infraEvents.runId, runId),
      gt(infraEvents.sequence, afterSequence),
    ))
    .orderBy(asc(infraEvents.sequence))
    .limit(2000);
  return rows.map(toRow);
}

export function subscribe(runId: number, listener: Listener): () => void {
  let set = listeners.get(runId);
  if (!set) {
    set = new Set();
    listeners.set(runId, set);
  }
  set.add(listener);

  return () => {
    const current = listeners.get(runId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(runId);
  };
}

function toRow(row: typeof infraEvents.$inferSelect): InfraEventRow {
  return {
    id: Number(row.id),
    runId: Number(row.runId),
    eventType: row.eventType,
    nodeKey: row.nodeKey ?? null,
    level: row.level,
    message: row.message,
    data: row.data,
    sequence: row.sequence,
    createdAt: row.createdAt,
  };
}
