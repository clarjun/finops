import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { InfraToolRegistry, toJsonSchema } from './registry';

const noop = async () => ({ ok: true });

const tool = (over: Partial<Parameters<InfraToolRegistry['register']>[0]> = {}) => ({
  name: 'test_tool',
  description: 'A tool',
  input: z.object({ a: z.string() }),
  risk: 'low' as const,
  requiredPermission: 'account:read' as const,
  idempotent: true,
  handler: noop,
  ...over,
});

describe('tool registry', () => {
  let registry: InfraToolRegistry;
  beforeEach(() => { registry = new InfraToolRegistry(); });

  it('registers and retrieves tools', () => {
    registry.register(tool());
    expect(registry.has('test_tool')).toBe(true);
    expect(registry.get('test_tool')?.risk).toBe('low');
  });

  it('refuses to overwrite an existing tool', () => {
    // Silent replacement would let a later module shadow a safety-critical tool
    // with a permissive one and nothing would say so.
    registry.register(tool());
    expect(() => registry.register(tool())).toThrow(/already registered/);
  });

  it('refuses retries on a non-idempotent tool', () => {
    // Caught at registration rather than at 3am: retrying a create that already
    // succeeded produces duplicate infrastructure.
    expect(() => registry.register(tool({ idempotent: false, maxRetries: 3 })))
      .toThrow(/declares retries but is not idempotent/);
  });

  it('allows a non-idempotent tool with no retries', () => {
    expect(() => registry.register(tool({ idempotent: false }))).not.toThrow();
  });

  it('never exposes handlers to the model', () => {
    registry.register(tool({ risk: 'critical', idempotent: false }));
    const described = registry.describeForModel();
    expect(described).toHaveLength(1);
    expect(described[0]).not.toHaveProperty('handler');
    expect(Object.keys(described[0]).sort()).toEqual(['description', 'inputSchema', 'name']);
  });

  it('tells the model the risk and idempotency of each tool', () => {
    registry.register(tool({ risk: 'critical', idempotent: false }));
    const [described] = registry.describeForModel();
    expect(described.description).toContain('risk: critical');
    expect(described.description).toContain('not idempotent');
  });
});

describe('zod to JSON Schema', () => {
  it('converts an object of primitives, marking optionals', () => {
    const schema = toJsonSchema(z.object({
      workspacePath: z.string(),
      cloudAccountId: z.number(),
      dryRun: z.boolean().optional(),
    }));

    expect(schema).toMatchObject({
      type: 'object',
      properties: {
        workspacePath: { type: 'string' },
        cloudAccountId: { type: 'number' },
        dryRun: { type: 'boolean' },
      },
    });
    expect(schema.required).toEqual(['workspacePath', 'cloudAccountId']);
  });

  it('converts enums and arrays', () => {
    expect(toJsonSchema(z.object({ mode: z.enum(['plan', 'apply']) })))
      .toMatchObject({ properties: { mode: { type: 'string', enum: ['plan', 'apply'] } } });
    expect(toJsonSchema(z.object({ tags: z.array(z.string()) })))
      .toMatchObject({ properties: { tags: { type: 'array', items: { type: 'string' } } } });
  });

  it('treats a defaulted field as optional', () => {
    const schema = toJsonSchema(z.object({ region: z.string().default('us-east-1') }));
    expect(schema.required).toBeUndefined();
  });

  it('throws on shapes it cannot represent rather than misdescribing the tool', () => {
    // A wrong schema produces malformed calls that fail deep inside a handler,
    // which is far harder to diagnose than a loud failure at registration.
    expect(() => toJsonSchema(z.object({ when: z.date() }))).toThrow(/does not support/);
  });
});
