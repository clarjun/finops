/**
 * The two decisions that determine what a teardown destroys.
 *
 * Kept out of teardown.ts so they can be tested without a database or a
 * container. They are small enough to look obviously correct and consequential
 * enough that "obviously correct" is not good enough.
 */

export interface PlanChange { address: string; action: string }

/**
 * Addresses a destroy plan will remove.
 *
 * Addresses rather than a count, because the approval shows a list and the
 * drift check compares sets. A count would let one resource be swapped for
 * another with neither check noticing.
 *
 * `replace` counts: Terraform reports a replacement as ["delete","create"], and
 * the delete half destroys the resource that exists today.
 */
export function destroyAddresses(planned: { changes: PlanChange[] }): string[] {
  return planned.changes
    .filter((c) => c.action === 'delete' || c.action === 'replace')
    .map((c) => c.address)
    // Sorted so an identical plan always produces an identical approval record.
    .sort();
}

/**
 * Resources in the current plan that nobody approved.
 *
 * Additions only. A resource that has since disappeared means the teardown does
 * less than was approved, which cannot surprise the approver — but anything new
 * would be destroyed without ever having been reviewed, and that is the failure
 * this function exists to prevent.
 *
 * An empty approved list therefore approves nothing, not everything.
 */
export function unapprovedAdditions(approved: string[], current: string[]): string[] {
  const seen = new Set(approved);
  return current.filter((address) => !seen.has(address));
}
