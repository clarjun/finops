/**
 * The infrastructure tool registry.
 *
 * Modelled on the platform's runtime ToolRegistry — a process-wide map that
 * modules populate at startup — with the fields a cloud tool needs and a chat
 * tool does not: a risk class, an idempotency declaration, a required
 * permission, and retry/timeout policy.
 *
 * The registry only stores tools. It deliberately cannot invoke one: everything
 * goes through invokeTool() in ./policy, so there is no code path that reaches a
 * cloud without passing authorization, the approval gate and the audit log.
 * A registry with a public `handler` would make that guarantee a convention
 * rather than a property.
 */
import { z } from 'zod';
import type { Permission } from '../../rbac';
import type { RiskLevel } from '../types';

export interface InfraToolContext {
  organizationId: number;
  userId?: number;
  username?: string;
  /** The run this call belongs to. Absent for ad-hoc calls (e.g. validation). */
  runId?: number;
  planId?: number;
  /** LAM node being acted on, when the call is part of a graph execution. */
  nodeKey?: string;
  /**
   * Live activity channel. A long-running tool reports progress through this so
   * the deployment view shows work happening rather than a silent spinner.
   */
  emit?: (e: { level?: 'info' | 'warn' | 'error'; message: string; data?: unknown }) => void;
  signal?: AbortSignal;
}

export interface InfraTool<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  /** Argument schema. Validated before the handler ever sees the arguments. */
  input: z.ZodType<TArgs>;
  /**
   * How dangerous a successful call is. Drives the approval gate, so it
   * describes the ACTION, not the likelihood of failure.
   */
  risk: RiskLevel;
  /** Permission the caller must hold. Checked against the RBAC matrix. */
  requiredPermission: Permission;
  /**
   * Whether repeating the call with identical arguments is safe. Only
   * idempotent tools are retried automatically; retrying a non-idempotent
   * create is how duplicate infrastructure appears.
   */
  idempotent: boolean;
  timeoutMs?: number;
  /** Automatic attempts on transient failure. Ignored unless idempotent. */
  maxRetries?: number;
  handler: (args: TArgs, ctx: InfraToolContext) => Promise<unknown>;
}

export class InfraToolRegistry {
  private readonly tools = new Map<string, InfraTool<any>>();

  register<T>(tool: InfraTool<T>): void {
    if (this.tools.has(tool.name)) {
      // Registration is idempotent so the execution path can guarantee the
      // registry is populated without depending on server start-up order — a
      // dependency that is exactly why the layer sat unused. Re-registering a
      // *different* tool under a known name is still an error, since that would
      // silently change what an approved call does.
      if (this.tools.get(tool.name) === tool) return;
      throw new Error(`Infrastructure tool "${tool.name}" is already registered`);
    }
    if (!tool.idempotent && (tool.maxRetries ?? 0) > 0) {
      // Catching this at registration rather than at 3am: a non-idempotent tool
      // with retries enabled will eventually create the same resource twice.
      throw new Error(`Tool "${tool.name}" declares retries but is not idempotent`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): InfraTool<any> | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): InfraTool<any>[] {
    return [...this.tools.values()];
  }

  /**
   * Tool definitions for a model, as JSON Schema.
   *
   * Handlers are never included. The model receives a name, a description and
   * an argument shape — enough to propose a call, and nothing that lets it make
   * one.
   */
  describeForModel(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return this.list().map((t) => ({
      name: t.name,
      description: `${t.description} (risk: ${t.risk}${t.idempotent ? '' : ', not idempotent'})`,
      inputSchema: toJsonSchema(t.input),
    }));
  }

  /** Test seam only. */
  clear(): void {
    this.tools.clear();
  }
}

/**
 * Minimal Zod -> JSON Schema conversion.
 *
 * Covers the shapes tool arguments actually use: an object of strings, numbers,
 * booleans, enums and arrays, with optionals. Anything richer throws rather than
 * emitting a schema that quietly misdescribes the tool to the model — a wrong
 * schema produces malformed calls that fail deep inside a handler.
 */
export function toJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const def = (schema as unknown as { _def: any })._def;

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = def.shape() as Record<string, z.ZodType<unknown>>;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        const inner = unwrapOptional(value);
        properties[key] = toJsonSchema(inner.schema);
        if (!inner.optional) required.push(key);
      }

      return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
    }

    case z.ZodFirstPartyTypeKind.ZodString:
      return { type: 'string', ...(def.description ? { description: def.description } : {}) };
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return { type: 'number' };
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: 'boolean' };
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return { type: 'string', enum: def.values };
    case z.ZodFirstPartyTypeKind.ZodArray:
      return { type: 'array', items: toJsonSchema(def.type) };
    case z.ZodFirstPartyTypeKind.ZodRecord:
      return { type: 'object', additionalProperties: true };

    default:
      throw new Error(
        `toJsonSchema does not support ${def.typeName}. Add support rather than shipping a schema ` +
        `that misdescribes the tool to the model.`,
      );
  }
}

function unwrapOptional(schema: z.ZodType<unknown>): { schema: z.ZodType<unknown>; optional: boolean } {
  const def = (schema as unknown as { _def: any })._def;
  if (def.typeName === z.ZodFirstPartyTypeKind.ZodOptional || def.typeName === z.ZodFirstPartyTypeKind.ZodDefault) {
    return { schema: def.innerType, optional: true };
  }
  return { schema, optional: false };
}

export const infraToolRegistry = new InfraToolRegistry();
