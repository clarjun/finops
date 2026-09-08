/**
 * The provider mapper contract.
 *
 * A mapper turns provider-neutral LAM nodes into concrete resources for one
 * cloud. Adding Azure means writing a mapper; it must never mean forking the
 * compiler, the DAG engine or the UI.
 *
 * A mapper that cannot express a logical type must say so explicitly. Silently
 * omitting a resource would produce a plan that deploys successfully while
 * missing something the user was quoted for — the failure mode this whole
 * pipeline is built to avoid.
 */
import type { HclBlock } from '../terraform/hcl';
import type { LamNode, LogicalArchitecture, LogicalType } from '../types';

export interface MappedResource {
  /** LAM node this came from. */
  nodeKey: string;
  /** Terraform address, e.g. `aws_vpc.main`. Joins plan output back to the node. */
  address: string;
  /** Provider resource type, e.g. `aws_vpc`. */
  providerType: string;
  blocks: HclBlock[];
}

export interface UnsupportedNode {
  nodeKey: string;
  logicalType: LogicalType;
  reason: string;
}

export interface MappingResult {
  resources: MappedResource[];
  /** Types this mapper cannot yet build. Surfaced to the user, never hidden. */
  unsupported: UnsupportedNode[];
  /** Provider/version and variable declarations the config needs. */
  preamble: HclBlock[];
  /** Terraform variables the executor must supply at plan/apply time. */
  variables: Record<string, { type: string; description: string; sensitive?: boolean }>;
}

export interface MapperContext {
  architecture: LogicalArchitecture;
  region: string;
  environment: string;
  /** Prefix applied to every physical name, keeping deployments distinguishable. */
  namePrefix: string;
}

export interface ProviderMapper {
  readonly provider: 'aws' | 'azure' | 'gcp';
  /** Logical types this mapper can build today. */
  readonly supports: ReadonlySet<LogicalType>;
  map(nodes: LamNode[], ctx: MapperContext): MappingResult;
}
