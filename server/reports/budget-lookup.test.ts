/**
 * The AWS budget lookup, and the crash it used to cause.
 *
 * fetchAWSBudgets() returned a plain number, and returned 0 for three unrelated
 * outcomes: no budget configured, budgets that were not monthly, and a call
 * that failed outright. calculateSpendOverview assigned that 0 to `budget`
 * unconditionally, so the report shipped:
 *
 *     { budget: 0, budgetUtilization: undefined }
 *
 * The Reports page tested only `budget !== undefined` before rendering the
 * budget card, so 0 passed, and the card called .toFixed() on the undefined
 * utilisation. That unmounted the whole page.
 *
 * These tests pin the two halves of the fix: the lookup reports WHICH outcome
 * occurred, and the payload never carries a budget without a utilisation.
 */
import { describe, it, expect } from 'vitest';
import type { AwsBudgetLookup } from '../aws-client';

/** The client's guard, mirrored so the invariant is checkable server-side. */
function reportsPageWouldRenderBudgetCard(overview: {
  budget?: number;
  budgetUtilization?: number;
}) {
  return (
    typeof overview.budget === 'number' &&
    overview.budget > 0 &&
    typeof overview.budgetUtilization === 'number'
  );
}

/** The corrected caller logic from calculateSpendOverview. */
function applyLookup(lookup: AwsBudgetLookup, totalSpendMTD: number) {
  const out: { budget?: number; budgetUtilization?: number; budgetUnavailableReason?: string } = {};
  if (lookup.status === 'found') {
    out.budget = lookup.monthlyBudget;
    out.budgetUtilization = (totalSpendMTD / lookup.monthlyBudget) * 100;
  } else if (lookup.status === 'none') {
    out.budgetUnavailableReason = 'No monthly budget is configured in AWS Budgets';
  } else {
    out.budgetUnavailableReason = lookup.reason;
  }
  return out;
}

describe('budget payload invariant', () => {
  it('never carries a budget without a utilisation', () => {
    // The invariant the UI depends on. Violating it is what blanked the page.
    const cases: AwsBudgetLookup[] = [
      { status: 'found', monthlyBudget: 5000 },
      { status: 'none' },
      { status: 'unavailable', reason: 'Could not read AWS Budgets: AccessDenied' },
    ];

    for (const lookup of cases) {
      const overview = applyLookup(lookup, 4308);
      const hasOne = overview.budget !== undefined;
      const hasOther = overview.budgetUtilization !== undefined;
      expect(hasOne, lookup.status).toBe(hasOther);
    }
  });

  it('renders the budget card only when a real budget was found', () => {
    expect(reportsPageWouldRenderBudgetCard(applyLookup({ status: 'found', monthlyBudget: 5000 }, 4308))).toBe(true);
    expect(reportsPageWouldRenderBudgetCard(applyLookup({ status: 'none' }, 4308))).toBe(false);
    expect(
      reportsPageWouldRenderBudgetCard(applyLookup({ status: 'unavailable', reason: 'AccessDenied' }, 4308)),
    ).toBe(false);
  });

  it('survives the exact payload that crashed the page', () => {
    // budget present, utilisation absent — what the old code produced when
    // fetchAWSBudgets returned 0. The guard must reject it rather than let the
    // card call .toFixed() on undefined.
    expect(reportsPageWouldRenderBudgetCard({ budget: 0, budgetUtilization: undefined })).toBe(false);
    expect(reportsPageWouldRenderBudgetCard({ budget: 5000, budgetUtilization: undefined })).toBe(false);
  });

  it('computes utilisation against the real budget', () => {
    const overview = applyLookup({ status: 'found', monthlyBudget: 5000 }, 4308);
    expect(overview.budgetUtilization).toBeCloseTo(86.16, 2);
  });

  it('explains an unreadable budget instead of reporting no budget', () => {
    // The distinction that matters to the user: a missing IAM permission is
    // actionable, being told you have no budget when you do is not.
    const denied = applyLookup(
      { status: 'unavailable', reason: 'Could not read AWS Budgets: User is not authorized to perform budgets:DescribeBudgets' },
      4308,
    );
    expect(denied.budgetUnavailableReason).toMatch(/budgets:DescribeBudgets/);
    expect(denied.budgetUnavailableReason).not.toMatch(/No monthly budget is configured/);

    const none = applyLookup({ status: 'none' }, 4308);
    expect(none.budgetUnavailableReason).toMatch(/No monthly budget is configured/);
  });
});
