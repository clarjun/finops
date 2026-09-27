/**
 * The words the Governance section uses to explain itself.
 *
 * Kept in one file because the same ideas have to be said the same way in five
 * places, and because the previous version said them nowhere. A reader arriving
 * at this section saw a score, five tab names and a list of "findings", with no
 * statement anywhere of what was being checked, by whom, how often, or what any
 * of it was for.
 *
 * Two rules for everything written here:
 *
 *   1. No internal vocabulary without a definition attached. "Policy",
 *      "finding", "enforcement", "not assessed" and "domain" are our words, not
 *      the reader's. Each one is defined the first time it appears.
 *
 *   2. Every number says what to do about it. A score with no next action is
 *      trivia. This follows what Defender for Cloud gets right — its most
 *      useful element is not the score but "potential score increase", which
 *      turns a measurement into a queue of work.
 */
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, HelpCircle, Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";

/** One line per tab, shown under the tab strip so the tab name is never alone. */
export const TAB_HELP: Record<string, string> = {
  posture:
    'The overall picture — your score, how many problems are open, and which areas are worst. Start here.',
  findings:
    'Every individual problem we found, one row each, with what it is, why it matters and how to fix it.',
  policies:
    'The rules themselves. Switch a rule on or off, and fill in the ones that need your own values — which regions you allow, which tags you require.',
  exemptions:
    'Problems you have deliberately decided to accept, each with a reason and an expiry date. They stay visible; they just stop counting against you.',
  frameworks:
    'How the rules we check line up with published standards like CIS and ISO 27001 — useful when an auditor asks what you cover.',
};

/** Plain definitions for the words this section cannot avoid using. */
export const GLOSSARY: Record<string, string> = {
  policy:
    'A rule we check your cloud against — for example "every volume must be encrypted". You choose which rules are on.',
  finding:
    'One specific thing that broke one rule — a named resource, in a named account. Fix the resource and the finding closes by itself on the next check.',
  score:
    'How much of what we checked is passing, weighted by how serious each rule is. A critical rule counts about ten times a low one, so fixing one critical problem moves the number more than fixing ten small ones.',
  domain:
    'The area a rule belongs to — cost, security, tagging, access or data residency. Domains let you see which part of your cloud is weakest.',
  enforcement:
    'What happens when a rule is broken. "Audit" records it, "warn" flags it loudly, and "block" is meant to stop the change from happening at all.',
  notAssessed:
    'A rule that ran but could not reach a verdict — usually because it had no data to look at, or because it needs a value from you first. These are left OUT of the score rather than counted as passing, because a question nobody answered is not a pass.',
  exemption:
    'A decision to accept a specific problem on purpose, with a reason recorded and a date it expires. Honest risk acceptance, not a way to hide something.',
  acknowledge:
    'Marks that a human has seen this and is dealing with it. It does NOT fix anything and it still counts against your score — it is a triage note, not a resolution.',
};

/**
 * A dotted-underline term that explains itself on hover.
 *
 * Used instead of a help page, because the moment someone needs the definition
 * of "not assessed" is the moment they are looking at the words "not assessed",
 * and sending them elsewhere loses them.
 */
export function Term({ k, children }: { k: keyof typeof GLOSSARY | string; children: ReactNode }) {
  const text = GLOSSARY[k];
  if (!text) return <>{children}</>;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="underline decoration-dotted decoration-muted-foreground/60 underline-offset-2 cursor-help"
          >
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-sm leading-relaxed">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** A small "?" that opens a definition. For places a dotted term would not fit. */
export function WhatIsThis({ k }: { k: keyof typeof GLOSSARY | string }) {
  const text = GLOSSARY[k];
  if (!text) return null;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label="What is this?" className="text-muted-foreground hover:text-foreground">
            <HelpCircle className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-sm leading-relaxed">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * The paragraph that should have been at the top of this page from the start.
 *
 * Collapsible and remembered, so it teaches a new reader once without nagging
 * someone who uses the section daily. It defaults to OPEN, because the cost of
 * a returning user collapsing it once is far lower than the cost of a new user
 * never discovering what the section does.
 */
export function GovernanceIntro({ policyCount }: { policyCount: number | null }) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem('governance.intro.collapsed') !== '1'; }
    catch { return true; }
  });

  const toggle = () => {
    setOpen(v => {
      try { localStorage.setItem('governance.intro.collapsed', v ? '1' : '0'); } catch { /* private mode */ }
      return !v;
    });
  };

  return (
    <Card className="bg-muted/30">
      <CardContent className="pt-4 pb-4">
        <button
          type="button"
          onClick={toggle}
          className="flex w-full items-center gap-2 text-left"
          aria-expanded={open}
        >
          <Info className="h-4 w-4 text-primary shrink-0" />
          <span className="font-medium text-sm flex-1">What is Governance, and what is this page doing?</span>
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </button>

        {open && (
          <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">
            <p>
              Cloudwise checks your cloud accounts against{' '}
              {policyCount === null ? 'a set of' : <strong className="text-foreground">{policyCount}</strong>}{' '}
              <Term k="policy"><span className="text-foreground">rules</span></Term> — things like
              “databases must not be reachable from the internet”, “every disk must be encrypted”,
              “every resource must carry an owner tag”. The check runs on a schedule, and whenever
              you press <em>Run evaluation</em>.
            </p>

            <p>
              Each rule that is broken produces a{' '}
              <Term k="finding"><span className="text-foreground">finding</span></Term>: one specific
              resource, in one account, with the reason it failed and what to do about it. Your{' '}
              <Term k="score"><span className="text-foreground">score</span></Term> is how much of
              what we checked is passing, weighted so that serious problems count for far more than
              minor ones.
            </p>

            <p className="text-foreground">
              <strong>The short version:</strong> the score tells you how you are doing, the
              findings tell you what to fix, and fixing a resource closes its finding automatically
              on the next run. You never have to mark anything as done.
            </p>

            <p className="text-xs">
              One deliberate choice worth knowing: a rule that could not reach a verdict is reported
              as <Term k="notAssessed"><span className="text-foreground">not assessed</span></Term>{' '}
              and left out of the score entirely, rather than being counted as a pass. It means the
              score is sometimes based on fewer rules than are switched on — but it also means a
              green number is never hiding a check that silently failed to run.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
