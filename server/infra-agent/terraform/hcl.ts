/**
 * A small, safe HCL writer.
 *
 * Terraform configuration is generated from a compiled plan, and parts of that
 * plan originate in a model-written estimate — service names, instance types,
 * bucket prefixes. Building HCL by string concatenation would let a stray quote
 * or `${...}` in any of those values change the meaning of the configuration.
 * That is template injection against infrastructure, and it is the reason this
 * module exists rather than a handful of template literals.
 *
 * Every value goes through `hclValue`, which quotes and escapes. The one
 * deliberate exception is `ref()`, which emits an unquoted Terraform expression
 * (e.g. `aws_vpc.main.id`) and is only ever constructed from identifiers this
 * codebase generates — never from plan input.
 */

/** An unquoted Terraform expression: a resource reference, variable or function. */
export interface HclRef {
  readonly __hclRef: true;
  expr: string;
}

/** Terraform identifiers: letters, digits, underscore and dash only. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Replacement for `${` that yields Terraform's literal-dollar escape `$${`.
 *
 * Deliberately a function, not the string '$${'. In String.replace a `$$` in
 * the replacement means "one literal $", so the obvious spelling silently
 * replaces `${` with `${` — a no-op, and an injection guard that guards
 * nothing. A function's return value is used verbatim.
 */
const escapeInterpolation = (): string => '$${';

/**
 * A reference to another resource's attribute. Every segment is validated as an
 * identifier, so a value that reached here from plan input cannot inject an
 * arbitrary expression.
 */
export function ref(expr: string): HclRef {
  const segments = expr.split('.');
  for (const s of segments) {
    if (!IDENT.test(s)) {
      throw new Error(`Invalid Terraform reference segment "${s}" in "${expr}"`);
    }
  }
  return { __hclRef: true, expr };
}

export function isRef(v: unknown): v is HclRef {
  return typeof v === 'object' && v !== null && (v as HclRef).__hclRef === true;
}

/**
 * A quoted string containing Terraform interpolations, e.g.
 * `"${var.name_prefix}-assets-${random_id.s.hex}"`.
 *
 * Built from parts rather than written as a literal: string parts are escaped
 * so they cannot introduce an interpolation, and reference parts go through
 * `ref()` so they cannot be arbitrary expressions. Writing this as a template
 * literal would reintroduce exactly the injection hole `hclValue` closes.
 */
export function interp(parts: Array<string | HclRef>): HclRef {
  const body = parts
    .map((p) => {
      if (isRef(p)) return `\${${p.expr}}`;
      // Escape for a quoted HCL string, then neutralise any `${` in the literal.
      return JSON.stringify(p).slice(1, -1).replace(/\$\{/g, escapeInterpolation);
    })
    .join('');
  return { __hclRef: true, expr: `"${body}"` };
}

/** A subscript into a list-valued reference, e.g. `data.x.names[0]`. */
export function index(base: HclRef, i: number): HclRef {
  if (!Number.isInteger(i) || i < 0) throw new Error(`Invalid index ${i}`);
  return { __hclRef: true, expr: `${base.expr}[${i}]` };
}

/** Sanitise arbitrary text into a valid Terraform identifier. */
export function toIdentifier(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z_]+/, '');
  const id = cleaned.length > 0 ? cleaned : 'r';
  return id.slice(0, 120);
}

/**
 * Serialise a JS value as HCL.
 *
 * Strings are JSON-encoded, which handles quotes, backslashes, newlines and
 * control characters. `$` is then escaped as `$${` so a value containing
 * `${...}` is a literal rather than a Terraform interpolation — the specific
 * case that turns generated config into an injection vector.
 */
export function hclValue(v: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);

  if (isRef(v)) return v.expr;
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);

  if (typeof v === 'string') {
    return JSON.stringify(v).replace(/\$\{/g, escapeInterpolation);
  }

  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    const items = v.map((i) => `${pad}  ${hclValue(i, indent + 1)}`).join(',\n');
    return `[\n${items}\n${pad}]`;
  }

  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, val]) => val !== undefined);
    if (entries.length === 0) return '{}';
    const body = entries
      .map(([k, val]) => `${pad}  ${IDENT.test(k) ? k : JSON.stringify(k)} = ${hclValue(val, indent + 1)}`)
      .join('\n');
    return `{\n${body}\n${pad}}`;
  }

  throw new Error(`Cannot serialise ${typeof v} to HCL`);
}

/** A nested block (e.g. `tags {}` or `ingress {}`) rather than an assignment. */
export interface HclBlock {
  type: string;
  labels?: string[];
  body: HclBody;
}

export type HclBody = Record<string, unknown> & { _blocks?: HclBlock[] };

export function renderBlock(block: HclBlock, indent = 0): string {
  const pad = '  '.repeat(indent);
  const labels = (block.labels ?? []).map((l) => ` ${JSON.stringify(l)}`).join('');
  const lines: string[] = [`${pad}${block.type}${labels} {`];

  for (const [key, value] of Object.entries(block.body)) {
    if (key === '_blocks' || value === undefined) continue;
    lines.push(`${pad}  ${key} = ${hclValue(value, indent + 1)}`);
  }

  for (const nested of block.body._blocks ?? []) {
    lines.push(renderBlock(nested, indent + 1));
  }

  lines.push(`${pad}}`);
  return lines.join('\n');
}

export function renderBlocks(blocks: HclBlock[]): string {
  return blocks.map((b) => renderBlock(b)).join('\n\n');
}
