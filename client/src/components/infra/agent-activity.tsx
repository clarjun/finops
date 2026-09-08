/**
 * The agent activity feed.
 *
 * Reads the run's durable event stream. Terraform's own output is interleaved
 * with the agent's decisions, because a user watching their infrastructure being
 * built deserves to see the actual tool output, not a sanitised summary of it.
 */
import { useEffect, useRef } from "react";
import { Wifi, WifiOff } from "lucide-react";
import type { InfraEvent } from "@/hooks/use-infra-agent";

/** Events that mark a decision rather than progress; shown with emphasis. */
const MILESTONES = new Set([
  'AGENT_STARTED', 'ARCHITECTURE_GENERATED', 'PLAN_VALIDATED', 'APPROVAL_REQUIRED',
  'APPROVED', 'REJECTED', 'DEPLOYMENT_COMPLETED', 'DEPLOYMENT_FAILED', 'RUN_RESUMED', 'KNOWLEDGE_SAVED',
]);

function levelClass(level: string, eventType: string): string {
  if (level === 'error') return 'text-destructive';
  if (level === 'warn') return 'text-yellow-600';
  if (MILESTONES.has(eventType)) return 'text-foreground font-medium';
  return 'text-muted-foreground';
}

export function AgentActivity({ events, connected }: { events: InfraEvent[]; connected: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Follow the tail, but only when the user is already at the bottom — yanking
  // the view while someone is reading an earlier failure is worse than not
  // following at all.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium">Agent activity</h3>
        <span
          className={`text-xs flex items-center gap-1 ${connected ? 'text-green-600' : 'text-muted-foreground'}`}
          title={connected ? 'Receiving live events' : 'Reconnecting — nothing is lost, events replay from where they stopped'}
        >
          {connected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
          {connected ? 'live' : 'reconnecting'}
        </span>
      </div>

      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto rounded-md border bg-muted/30 p-3 font-mono text-xs space-y-1 min-h-[220px] max-h-[420px]"
        data-testid="agent-activity"
      >
        {events.length === 0 ? (
          <p className="text-muted-foreground">Waiting for the agent to start…</p>
        ) : (
          events.map((e) => (
            <div key={e.id} className="flex gap-2">
              <span className="text-muted-foreground/60 shrink-0 tabular-nums">
                {new Date(e.createdAt).toLocaleTimeString([], { hour12: false })}
              </span>
              <span className={`${levelClass(e.level, e.eventType)} break-words`}>
                {MILESTONES.has(e.eventType) && (
                  <span className="text-[10px] uppercase tracking-wide mr-1.5 opacity-70">
                    {e.eventType.replace(/_/g, ' ').toLowerCase()}
                  </span>
                )}
                {e.message}
              </span>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
