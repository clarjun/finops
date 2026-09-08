/**
 * Documentation research.
 *
 * The Standard Step Library records what worked. This records *why it is the
 * right way to do it* — the provider documentation, at the provider version the
 * configuration was actually pinned to, that describes the resource being built.
 *
 * Two things depend on it:
 *
 *   provenance   a step whose source can be re-read is knowledge; a step whose
 *                source nobody can find is folklore. The library shows the
 *                difference, so this has to fill it in honestly.
 *   drift        provider arguments get deprecated and removed. Comparing the
 *                arguments we emit against the ones the current docs list
 *                catches a configuration going stale before Terraform does.
 *
 * The hard rule here is that nothing is recorded unless it was retrieved. The
 * canonical registry URL for a resource is entirely predictable from its type,
 * so it would be trivial to write a plausible URL into `doc_sources` without
 * ever fetching anything — and the library would then display fabricated
 * provenance that looks exactly like the real thing. Every function below
 * returns null on failure rather than constructing a URL it has not confirmed.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { standardSteps, docSources } from '@shared/schema';
import { appendEvent } from '../events';

const REGISTRY = 'https://registry.terraform.io';

/** The registry is a third party on the deployment path; it never gets to hang a run. */
const FETCH_TIMEOUT_MS = 15_000;

/** Provider version constraints as emitted by the mappers. */
const PROVIDER_SOURCES: Record<string, { namespace: string; name: string; constraint: string }> = {
  aws: { namespace: 'hashicorp', name: 'aws', constraint: '~> 5.0' },
};

/**
 * Arguments Terraform itself defines, which no provider document lists.
 * Without these the drift audit would flag `tags`-adjacent meta-arguments on
 * every single resource and be ignored within a day.
 */
const META_ARGUMENTS = new Set([
  'count', 'for_each', 'provider', 'depends_on', 'lifecycle', 'provisioner', 'connection',
]);

export interface ResourceDoc {
  provider: string;
  resourceType: string;
  /** The exact provider version this document describes — not "latest". */
  version: string;
  url: string;
  title: string;
  subcategory: string | null;
  excerpt: string;
  /** Argument names the document lists, for the drift audit. */
  arguments: string[];
}

/* -------------------------------------------------------------------------- */
/*  Registry access                                                            */
/* -------------------------------------------------------------------------- */

async function getJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'CloudWise-InfraAgent' },
    });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    // Offline, rate-limited, or slow. All three mean the same thing here: we do
    // not know, and must not pretend otherwise.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a released version satisfies a pin.
 *
 * Only the two forms the mappers actually emit are implemented — `~> x.y` and an
 * exact version. An unrecognised constraint returns false for everything rather
 * than falling through to "matches anything", because the failure mode of the
 * permissive reading is documentation from the wrong major version presented as
 * authoritative.
 */
export function satisfies(version: string, constraint: string): boolean {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return false;
  // Pre-release versions ("5.0.0-beta1") parse as NaN above and are excluded,
  // which is what we want: a step should not cite a beta document.

  const pessimistic = constraint.match(/^~>\s*(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (pessimistic) {
    const [, majorStr, minorStr, patchStr] = pessimistic;
    const major = Number(majorStr), minor = Number(minorStr);
    if (patchStr === undefined) {
      // `~> 5.0` — anything in major 5, at or above minor 0.
      return parts[0] === major && parts[1] >= minor;
    }
    // `~> 5.1.2` — major and minor fixed, patch may rise.
    return parts[0] === major && parts[1] === minor && parts[2] >= Number(patchStr);
  }

  const exact = constraint.trim().replace(/^=\s*/, '');
  return /^\d+\.\d+\.\d+$/.test(exact) && exact === version;
}

const compareVersions = (a: string, b: string): number => {
  const [am, an, ap] = a.split('.').map(Number);
  const [bm, bn, bp] = b.split('.').map(Number);
  return am - bm || an - bn || ap - bp;
};

interface VersionResolution { version: string; versionId: string }

const versionCache = new Map<string, VersionResolution | null>();

/**
 * The highest released provider version satisfying our pin, and the registry's
 * internal id for it — documents are addressed by that id, not by the version
 * string.
 */
export async function resolveProviderVersion(provider: string): Promise<VersionResolution | null> {
  const spec = PROVIDER_SOURCES[provider];
  if (!spec) return null;

  const cacheKey = `${provider}:${spec.constraint}`;
  if (versionCache.has(cacheKey)) return versionCache.get(cacheKey)!;

  const body = await getJson<{ included?: Array<{ id: string; attributes: { version: string } }> }>(
    `${REGISTRY}/v2/providers/${spec.namespace}/${spec.name}?include=provider-versions`,
  );

  let resolved: VersionResolution | null = null;
  if (body?.included?.length) {
    const matching = body.included
      .filter((v) => satisfies(v.attributes.version, spec.constraint))
      .sort((a, b) => compareVersions(a.attributes.version, b.attributes.version));
    const best = matching.at(-1);
    if (best) resolved = { version: best.attributes.version, versionId: best.id };
  }

  versionCache.set(cacheKey, resolved);
  return resolved;
}

const docCache = new Map<string, ResourceDoc | null>();

/**
 * The provider document for one resource type, e.g. `aws_vpc`.
 *
 * Returns null when the document could not be retrieved OR does not exist. Both
 * are reported the same way to callers because both mean the same thing: we have
 * no source to cite.
 */
export async function fetchResourceDoc(provider: string, resourceType: string): Promise<ResourceDoc | null> {
  const spec = PROVIDER_SOURCES[provider];
  if (!spec) return null;

  const cacheKey = `${provider}:${resourceType}`;
  if (docCache.has(cacheKey)) return docCache.get(cacheKey)!;

  const resolved = await resolveProviderVersion(provider);
  if (!resolved) { docCache.set(cacheKey, null); return null; }

  // Registry slugs drop the provider prefix: aws_vpc -> vpc.
  const slug = resourceType.startsWith(`${spec.name}_`)
    ? resourceType.slice(spec.name.length + 1)
    : resourceType;

  const index = await getJson<{ data?: Array<{ id: string }> }>(
    `${REGISTRY}/v2/provider-docs` +
    `?filter%5Bprovider-version%5D=${resolved.versionId}` +
    `&filter%5Bcategory%5D=resources` +
    `&filter%5Bslug%5D=${encodeURIComponent(slug)}` +
    `&filter%5Blanguage%5D=hcl&page%5Bsize%5D=1`,
  );
  const docId = index?.data?.[0]?.id;
  if (!docId) { docCache.set(cacheKey, null); return null; }

  const full = await getJson<{ data?: { attributes: { content?: string; title?: string; subcategory?: string } } }>(
    `${REGISTRY}/v2/provider-docs/${docId}`,
  );
  const content = full?.data?.attributes?.content;
  if (!content) { docCache.set(cacheKey, null); return null; }

  const doc: ResourceDoc = {
    provider,
    resourceType,
    version: resolved.version,
    // Pinned to the resolved version, not `/latest/`. A citation that silently
    // re-points at a future document is not a citation.
    url: `${REGISTRY}/providers/${spec.namespace}/${spec.name}/${resolved.version}/docs/resources/${slug}`,
    title: full!.data!.attributes.title || resourceType,
    subcategory: full!.data!.attributes.subcategory ?? null,
    excerpt: summarise(content),
    arguments: documentedArguments(content),
  };

  docCache.set(cacheKey, doc);
  return doc;
}

/* -------------------------------------------------------------------------- */
/*  Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/** The prose description, with the YAML front matter and headings stripped. */
export function summarise(markdown: string, limit = 500): string {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
  const prose = body
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('```'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return prose.length > limit ? `${prose.slice(0, limit - 1)}…` : prose;
}

/**
 * Argument names listed under "Argument Reference".
 *
 * Nested block sections (`### timeouts`, `### ingress`) fall inside the captured
 * range deliberately, so their arguments join the same flat set. That makes the
 * set a superset of the top-level arguments, which biases the drift audit
 * towards silence: a real deprecation might go unmentioned, but a valid
 * argument will not be flagged as unknown. An audit that cries wolf is an audit
 * people switch off, and this one has to survive being read on every run.
 */
export function documentedArguments(markdown: string): string[] {
  const start = markdown.search(/^##\s+Argument Reference/im);
  if (start === -1) return [];

  const rest = markdown.slice(start + 1);
  // `## ` and not `### ` — a three-hash heading is a nested block, still ours.
  const endOffset = rest.search(/^##\s(?!#)/m);
  const section = endOffset === -1 ? rest : rest.slice(0, endOffset);

  const names = new Set<string>();
  for (const match of section.matchAll(/^\s*[*-]\s*`([a-z][a-z0-9_]*)`/gim)) {
    names.add(match[1]);
  }
  return [...names];
}

/**
 * Top-level argument names assigned in one HCL resource block.
 *
 * Depth-tracked rather than a flat regex: `tags = { Name = "x" }` and nested
 * blocks would otherwise contribute their inner keys, and every one of those
 * would be reported as an undocumented argument on the resource.
 */
export function emittedArguments(hclFragment: string): string[] {
  const names = new Set<string>();
  let depth = 0;

  for (const rawLine of hclFragment.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    // Read the identifier before adjusting depth: an argument sits at the depth
    // its line opens with, not the one it closes into.
    if (depth === 1) {
      const assignment = line.match(/^([a-z][a-z0-9_]*)\s*=/i);
      const block = line.match(/^([a-z][a-z0-9_]*)\s*\{/i);
      const name = assignment?.[1] ?? block?.[1];
      if (name) names.add(name);
    }

    for (const ch of line) {
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
    }
  }

  return [...names];
}

export interface DriftReport {
  resourceType: string;
  version: string;
  url: string;
  checked: number;
  /** Emitted but absent from the current documentation. */
  undocumented: string[];
}

/**
 * Compares what we emit against what the current provider documents.
 *
 * Reports; never blocks. A finding here is a prompt for a human to look, not a
 * verdict — the registry document could be incomplete, and refusing to deploy
 * over a documentation mismatch would make an advisory signal into an outage.
 */
export function auditArguments(hclFragment: string, doc: ResourceDoc): DriftReport {
  const emitted = emittedArguments(hclFragment);
  const documented = new Set(doc.arguments);

  return {
    resourceType: doc.resourceType,
    version: doc.version,
    url: doc.url,
    checked: emitted.length,
    undocumented: doc.arguments.length === 0
      // No parsed argument list means no basis for comparison. Reporting every
      // emitted argument as undocumented would be worse than reporting nothing.
      ? []
      : emitted.filter((a) => !documented.has(a) && !META_ARGUMENTS.has(a)),
  };
}

/* -------------------------------------------------------------------------- */
/*  Attaching provenance to learned steps                                      */
/* -------------------------------------------------------------------------- */

export interface ResearchResult {
  researched: number;
  recorded: number;
  unavailable: string[];
  drift: DriftReport[];
}

/**
 * Finds the documentation for steps that have none, and records it.
 *
 * A step is skipped only when it already cites the provider version currently
 * in force. "Has some row" is the wrong test: it treats a hand-entered or
 * unversioned link as settled, so a step could carry a citation nobody can tie
 * to the configuration it describes and never be researched again. Keying on
 * the resolved version also means a provider bump re-cites everything, which is
 * exactly when a citation is most likely to have gone stale.
 *
 * Idempotent in the ordinary case: running it twice against the same provider
 * version records nothing the second time.
 */
export async function researchSteps(options: { slugs?: string[]; runId?: number; limit?: number } = {}): Promise<ResearchResult> {
  const result: ResearchResult = { researched: 0, recorded: 0, unavailable: [], drift: [] };

  const steps = await db.select().from(standardSteps)
    .where(isNull(standardSteps.organizationId))
    .orderBy(desc(standardSteps.id))
    .limit(options.limit ?? 100);

  const wanted = options.slugs?.length ? new Set(options.slugs) : null;

  for (const step of steps) {
    if (wanted && !wanted.has(step.slug)) continue;
    if (!step.resourceType) continue;

    const current = await resolveProviderVersion(step.provider);
    // Without a resolved version there is nothing to compare against and
    // nothing to fetch; report it as unavailable rather than guessing.
    if (!current) { result.researched++; result.unavailable.push(step.slug); continue; }

    const [existing] = await db.select({ id: docSources.id }).from(docSources)
      .where(and(
        eq(docSources.standardStepId, step.id),
        eq(docSources.docVersion, current.version),
      ))
      .limit(1);
    if (existing) continue;

    result.researched++;

    const doc = await fetchResourceDoc(step.provider, step.resourceType);
    if (!doc) {
      result.unavailable.push(step.slug);
      continue;
    }

    await db.insert(docSources).values({
      standardStepId: step.id,
      provider: doc.provider,
      service: step.service ?? null,
      title: doc.title,
      url: doc.url,
      docVersion: doc.version,
      excerpt: doc.excerpt,
      runId: options.runId ?? null,
      retrievedAt: new Date(),
    });
    result.recorded++;

    if (step.implementation) {
      const report = auditArguments(step.implementation, doc);
      if (report.undocumented.length > 0) result.drift.push(report);
    }
  }

  return result;
}

/**
 * Best-effort research pass at the end of a successful run.
 *
 * Wrapped so that no registry problem can fail a deployment that has already
 * finished. The run is over; the resources exist. Losing the citation is a
 * gap in the library, not a deployment failure, and must never be reported as one.
 */
export async function attachProvenanceForRun(runId: number): Promise<void> {
  try {
    const result = await researchSteps({ runId });
    if (result.researched === 0) return;

    if (result.recorded > 0) {
      await appendEvent({
        runId,
        eventType: 'DOCUMENTATION_RETRIEVED',
        message: `Cited provider documentation for ${result.recorded} step(s).`,
        data: { recorded: result.recorded, unavailable: result.unavailable },
      });
    }

    if (result.unavailable.length > 0) {
      await appendEvent({
        runId,
        eventType: 'DOCUMENTATION_RETRIEVED',
        level: 'warn',
        message:
          `Could not retrieve documentation for ${result.unavailable.length} step(s); ` +
          `they are stored without a source and are marked as such in the library.`,
        data: { unavailable: result.unavailable },
      });
    }

    for (const report of result.drift) {
      await appendEvent({
        runId,
        eventType: 'DOCUMENTATION_RETRIEVED',
        level: 'warn',
        message:
          `${report.resourceType} sets ${report.undocumented.join(', ')}, which the ` +
          `${report.version} documentation does not list. Worth checking for a deprecation.`,
        data: report,
      });
    }
  } catch (err) {
    console.warn('[InfraAgent] documentation research failed:', err);
  }
}

/** Test seam: the caches are process-lifetime and would leak between cases. */
export function __clearDocCaches(): void {
  versionCache.clear();
  docCache.clear();
}
