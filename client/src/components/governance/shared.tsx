/**
 * Presentation pieces shared by the governance screens.
 *
 * Severity colour lives here rather than in each view because the colour IS the
 * meaning on this screen — the same severity rendered amber in one table and
 * red in another would quietly change what a reader believes about the finding.
 */
import { Badge } from "@/components/ui/badge";
import {
  SEVERITY_LABEL,
  ENFORCEMENT_LABEL,
  type PolicySeverity,
  type EnforcementMode,
  type PolicyDomain,
} from "@shared/governance";
import { Tags, DollarSign, ShieldAlert, KeyRound, Activity } from "lucide-react";

/**
 * Explicit classes rather than a template string: Tailwind's scanner only sees
 * literals, so `bg-${colour}-500` compiles to nothing in production.
 */
const SEVERITY_CLASS: Record<PolicySeverity, string> = {
  critical: 'bg-red-600/15 text-red-600 border-red-600/30 dark:text-red-400',
  high:     'bg-orange-500/15 text-orange-600 border-orange-500/30 dark:text-orange-400',
  medium:   'bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400',
  low:      'bg-sky-500/15 text-sky-600 border-sky-500/30 dark:text-sky-400',
  info:     'bg-muted text-muted-foreground border-border',
};

export function SeverityBadge({ severity }: { severity: PolicySeverity }) {
  return (
    <Badge variant="outline" className={`${SEVERITY_CLASS[severity]} font-medium`}>
      {SEVERITY_LABEL[severity]}
    </Badge>
  );
}

const ENFORCEMENT_CLASS: Record<EnforcementMode, string> = {
  audit: 'bg-muted text-muted-foreground border-border',
  warn:  'bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400',
  block: 'bg-red-600/15 text-red-600 border-red-600/30 dark:text-red-400',
};

export function EnforcementBadge({ mode }: { mode: EnforcementMode }) {
  return (
    <Badge variant="outline" className={ENFORCEMENT_CLASS[mode]}>
      {ENFORCEMENT_LABEL[mode]}
    </Badge>
  );
}

export const DOMAIN_ICON: Record<PolicyDomain, typeof Tags> = {
  tagging: Tags,
  cost: DollarSign,
  security: ShieldAlert,
  access: KeyRound,
  operations: Activity,
};

export function money(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`;
  return `$${n.toFixed(2)}`;
}

/** "3 days ago", not an ISO string. Ageing is the point of first-seen. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'unknown';

  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 0) {
    const ahead = Math.abs(seconds);
    if (ahead < 86400) return `in ${Math.max(1, Math.round(ahead / 3600))}h`;
    return `in ${Math.round(ahead / 86400)} days`;
  }
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  const days = Math.floor(seconds / 86400);
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  return `${Math.floor(days / 30)} months ago`;
}

/** Days until an expiry, floored at zero. */
export function daysUntil(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

const SCORE_CLASS = (score: number): string =>
  score >= 85 ? 'text-green-600 dark:text-green-400'
  : score >= 70 ? 'text-amber-600 dark:text-amber-400'
  : 'text-red-600 dark:text-red-400';

export function ScoreNumber({ score, className = '' }: { score: number; className?: string }) {
  return <span className={`${SCORE_CLASS(score)} ${className}`}>{score.toFixed(0)}</span>;
}

/** A thin bar. Deliberately not a chart library import for one rectangle. */
export function ScoreBar({ score }: { score: number }) {
  const tone = score >= 85 ? 'bg-green-500' : score >= 70 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(2, Math.min(100, score))}%` }} />
    </div>
  );
}
