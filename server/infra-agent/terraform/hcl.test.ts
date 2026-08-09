import { describe, it, expect } from 'vitest';
import { hclValue, ref, interp, index, toIdentifier, renderBlock } from './hcl';

describe('HCL value escaping', () => {
  it('quotes and escapes strings', () => {
    expect(hclValue('plain')).toBe('"plain"');
    expect(hclValue('with "quotes"')).toBe('"with \\"quotes\\""');
    expect(hclValue('line\nbreak')).toBe('"line\\nbreak"');
  });

  it('neutralises Terraform interpolation in string values', () => {
    // The injection case. A bucket prefix or instance type reaching the
    // generator from a model-written estimate must never become an expression.
    expect(hclValue('${aws_vpc.main.id}')).toBe('"$${aws_vpc.main.id}"');
    expect(hclValue('a${file("/etc/passwd")}b')).toBe('"a$${file(\\"/etc/passwd\\")}b"');
  });

  it('emits scalars unquoted', () => {
    expect(hclValue(42)).toBe('42');
    expect(hclValue(true)).toBe('true');
    expect(hclValue(null)).toBe('null');
  });

  it('renders references unquoted', () => {
    expect(hclValue(ref('aws_vpc.main.id'))).toBe('aws_vpc.main.id');
  });

  it('renders nested maps and lists', () => {
    expect(hclValue({ a: 1 })).toBe('{\n  a = 1\n}');
    expect(hclValue([])).toBe('[]');
    expect(hclValue(['x'])).toBe('[\n  "x"\n]');
  });

  it('omits undefined map entries rather than writing "undefined"', () => {
    expect(hclValue({ a: 1, b: undefined })).toBe('{\n  a = 1\n}');
  });
});

describe('references', () => {
  it('accepts valid identifier paths', () => {
    expect(ref('aws_vpc.main.id').expr).toBe('aws_vpc.main.id');
    expect(ref('var.region').expr).toBe('var.region');
  });

  it('rejects anything that is not an identifier path', () => {
    // ref() is the one place unquoted text reaches the output, so it must never
    // accept a value that could carry an expression.
    for (const bad of ['aws_vpc.main.id; rm -rf /', 'a b', '${x}', 'x."y"', '']) {
      expect(() => ref(bad), bad).toThrow(/Invalid Terraform reference/);
    }
  });

  it('indexes only with non-negative integers', () => {
    expect(index(ref('data.x.names'), 0).expr).toBe('data.x.names[0]');
    expect(() => index(ref('data.x.names'), -1)).toThrow();
    expect(() => index(ref('data.x.names'), 1.5)).toThrow();
  });
});

describe('interpolated strings', () => {
  it('builds a quoted string with embedded references', () => {
    expect(interp([ref('var.name_prefix'), '-assets-', ref('random_id.s.hex')]).expr)
      .toBe('"${var.name_prefix}-assets-${random_id.s.hex}"');
  });

  it('escapes interpolation inside the literal parts', () => {
    // Literal parts are data, reference parts are code. Mixing them up is the
    // whole class of bug this function exists to prevent.
    expect(interp(['${evil}', ref('var.region')]).expr).toBe('"$${evil}${var.region}"');
  });
});

describe('identifiers', () => {
  it('sanitises node keys into valid Terraform identifiers', () => {
    expect(toIdentifier('network.subnet.public.a')).toBe('network_subnet_public_a');
    expect(toIdentifier('data.postgres')).toBe('data_postgres');
  });

  it('strips leading characters Terraform will not accept', () => {
    expect(toIdentifier('123abc')).toBe('abc');
  });

  it('always yields something Terraform will parse, whatever the input', () => {
    // The guarantee that matters is validity, not a particular fallback string.
    const valid = /^[A-Za-z_][A-Za-z0-9_-]*$/;
    for (const input of ['!!!', '', '123', '   ', '../../etc', '🔥']) {
      expect(toIdentifier(input), `input: ${JSON.stringify(input)}`).toMatch(valid);
    }
  });
});

describe('block rendering', () => {
  it('renders a labelled block with nested blocks', () => {
    const out = renderBlock({
      type: 'resource',
      labels: ['aws_s3_bucket', 'assets'],
      body: { bucket: 'my-bucket', _blocks: [{ type: 'versioning_configuration', body: { status: 'Enabled' } }] },
    });
    expect(out).toContain('resource "aws_s3_bucket" "assets" {');
    expect(out).toContain('bucket = "my-bucket"');
    expect(out).toContain('  versioning_configuration {');
    expect(out.trim().endsWith('}')).toBe(true);
  });
});
