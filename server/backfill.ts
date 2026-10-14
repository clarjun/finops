/**
 * Backfill cost history for every tenant.
 *
 *   BACKFILL_START=2026-05-01 BACKFILL_END=2026-10-14 node dist/backfill.js
 *   BACKFILL_PROVIDERS=aws,azure  (optional; defaults to all three)
 *
 * Why this exists as a script rather than only an endpoint:
 *
 * The scheduler ingests a 7-day rolling window, which is right for its job —
 * providers restate the last several days of a bill — but it never reaches
 * further back. So a database that starts empty stays empty for every month
 * before it existed, and the six-month cost trend renders honestly from one day
 * of data. Production showed September as $3,306.99 because September contained
 * exactly one day.
 *
 * `POST /api/costs/ingest` does the same work, but reaching it needs an
 * authenticated admin session, and the database it must write to has no public
 * endpoint. A script can run as a job inside the VNet, which is the only place
 * that database is reachable from.
 *
 * Tenants are iterated explicitly. There is no ambient default organization,
 * and backfilling whichever tenant happened to be first would be worse than
 * failing.
 *
 * This spends money. AWS Cost Explorer bills per request, so the API call count
 * is reported per provider rather than hidden.
 */
import "dotenv/config";

import { storage } from "./storage";
import { runAsSystem } from "./tenant-context";
import { ingestAllProviders } from "./ingestion/ingest";
import type { CloudProvider } from "@shared/schema";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function arg(name: string): string | undefined {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (flag) return flag.split("=").slice(1).join("=");
  return process.env[`BACKFILL_${name.toUpperCase()}`];
}

async function main() {
  const start = arg("start");
  const end = arg("end");

  if (!start || !end || !DAY.test(start) || !DAY.test(end)) {
    console.error(
      "BACKFILL_START and BACKFILL_END are required, as YYYY-MM-DD.\n\n" +
        "Both are mandatory on purpose: a backfill with a defaulted range would\n" +
        "silently do the same short window the scheduler already does, and look\n" +
        "like it worked.",
    );
    process.exit(1);
  }

  if (new Date(start) > new Date(end)) {
    console.error("start must be on or before end.");
    process.exit(1);
  }

  const providers = arg("providers")
    ?.split(",")
    .map((p) => p.trim())
    .filter(Boolean) as CloudProvider[] | undefined;

  const orgs = await storage.listActiveOrganizations();
  console.log(
    `Backfilling ${start} .. ${end} for ${orgs.length} organization(s)` +
      `${providers ? ` (${providers.join(", ")})` : ""}`,
  );

  let records = 0;
  let apiCalls = 0;
  const failures: string[] = [];

  for (const org of orgs) {
    // trigger: 'backfill' so these runs are distinguishable in ingestion_runs
    // from the scheduled ones. Otherwise the run history cannot answer "has
    // this tenant ever had its history loaded?".
    const results = await runAsSystem(org.id, () =>
      ingestAllProviders({ range: { start, end }, providers, trigger: "backfill" }),
    );

    for (const r of results) {
      records += r.recordsIngested;
      apiCalls += r.apiCalls;
      const detail = `org ${org.id} ${r.provider}: ${r.recordsIngested} records, ${r.apiCalls} API calls`;
      if (r.status === "failed") {
        failures.push(`${detail} — ${r.error}`);
        console.error(`  FAILED  ${detail} — ${r.error}`);
      } else {
        console.log(`  ok      ${detail}`);
      }
    }
  }

  console.log(`\n${records} record(s) written, ${apiCalls} billing-API call(s).`);

  if (failures.length) {
    // Non-zero, because a partial backfill that reports success is how a gap
    // in the history gets mistaken for a month that genuinely cost less.
    console.error(`\n${failures.length} provider run(s) failed:`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // Message only: a provider or pg error can carry credentials, and this runs
    // in CI and job logs that are retained.
    console.error("Backfill failed:", err?.message ?? err);
    process.exit(1);
  });
