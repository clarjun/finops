import { describe, it, expect } from 'vitest';
import { inspectPlan, summarizeFindings, hasBlockingFindings } from './plan-risk';
import type { PlannedChange } from './executor';

const change = (over: Partial<PlannedChange> = {}): PlannedChange => ({
  address: 'aws_db_instance.main',
  resourceType: 'aws_db_instance',
  action: 'create',
  after: {},
  ...over,
});

const titles = (changes: PlannedChange[]) => inspectPlan(changes).map(f => f.title);

describe('the rule that matters most: silence when nothing is wrong', () => {
  it('finds nothing in a well-configured plan', () => {
    const findings = inspectPlan([
      change({ after: { publicly_accessible: false, storage_encrypted: true, backup_retention_period: 7 } }),
      change({ address: 'aws_s3_bucket.assets', resourceType: 'aws_s3_bucket', after: { acl: 'private' } }),
    ]);
    expect(findings).toEqual([]);
  });

  it('does not treat a MISSING attribute as insecure', () => {
    // The single most important restraint here. Terraform omits attributes
    // whose value is not yet known, and providers apply their own defaults.
    // Flagging absence would fire on nearly every resource, and a review
    // surface that cries wolf gets clicked through — which is worse than no
    // review, because it manufactures a record of oversight.
    expect(inspectPlan([change({ after: {} })])).toEqual([]);
    expect(inspectPlan([change({ after: undefined })])).toEqual([]);
  });

  it('ignores no-op style changes with no attributes', () => {
    expect(inspectPlan([])).toEqual([]);
  });
});

describe('public exposure', () => {
  it('flags a publicly accessible database as critical', () => {
    const findings = inspectPlan([change({ after: { publicly_accessible: true } })]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].attribute).toBe('publicly_accessible');
    expect(findings[0].title).toMatch(/public internet/i);
  });

  it('flags a public IP on an instance', () => {
    expect(titles([change({
      resourceType: 'aws_instance',
      after: { associate_public_ip_address: true },
    })])).toContain('Instance will get a public IP address');
  });

  it('understands the Azure spelling of the same idea', () => {
    const findings = inspectPlan([change({
      resourceType: 'azurerm_mssql_server',
      after: { public_network_access_enabled: true },
    })]);
    expect(findings[0].severity).toBe('critical');
  });
});

describe('encryption', () => {
  it('flags encryption explicitly disabled', () => {
    const findings = inspectPlan([change({ after: { storage_encrypted: false } })]);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].detail).toMatch(/only be set at\s+creation/);
  });

  it('accepts any of the provider spellings', () => {
    for (const key of ['encrypted', 'encryption_enabled', 'infrastructure_encryption_enabled']) {
      expect(inspectPlan([change({ after: { [key]: false } })])).toHaveLength(1);
    }
  });

  it('reports one finding even when several spellings are present', () => {
    // They all mean the same thing; three findings for one problem is noise.
    const findings = inspectPlan([change({ after: { storage_encrypted: false, encrypted: false } })]);
    expect(findings).toHaveLength(1);
  });
});

describe('open ingress', () => {
  const sg = (ingress: unknown) =>
    change({ address: 'aws_security_group.web', resourceType: 'aws_security_group', after: { ingress } });

  it('flags SSH open to the world as critical and names the protocol', () => {
    const findings = inspectPlan([sg([{ from_port: 22, to_port: 22, cidr_blocks: ['0.0.0.0/0'] }])]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].title).toContain('SSH');
  });

  it('flags a port range that swallows an admin port', () => {
    // 20-30 contains 22. A rule keyed on exact port numbers would miss it.
    expect(titles([sg([{ from_port: 20, to_port: 30, cidr_blocks: ['0.0.0.0/0'] }])])[0]).toContain('SSH');
  });

  it('treats every port open to the world as critical', () => {
    const findings = inspectPlan([sg([{ from_port: 0, to_port: 65535, cidr_blocks: ['0.0.0.0/0'] }])]);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].title).toMatch(/Every port/);
  });

  it('flags a non-admin port open to the world at a lower severity', () => {
    const findings = inspectPlan([sg([{ from_port: 8080, to_port: 8080, cidr_blocks: ['0.0.0.0/0'] }])]);
    expect(findings[0].severity).toBe('high');
  });

  it('leaves a restricted CIDR alone', () => {
    expect(inspectPlan([sg([{ from_port: 22, to_port: 22, cidr_blocks: ['10.0.0.0/8'] }])])).toEqual([]);
  });

  it('catches the IPv6 spelling of open-to-the-world', () => {
    expect(inspectPlan([sg([{ from_port: 22, to_port: 22, ipv6_cidr_blocks: ['::/0'] }])])).toHaveLength(1);
  });

  it('handles a single ingress object as well as a list', () => {
    expect(inspectPlan([sg({ from_port: 22, to_port: 22, cidr_blocks: ['0.0.0.0/0'] })])).toHaveLength(1);
  });
});

describe('public storage', () => {
  const bucket = (after: Record<string, unknown>) =>
    change({ address: 'aws_s3_bucket.assets', resourceType: 'aws_s3_bucket', after });

  it('flags a public-read ACL', () => {
    const findings = inspectPlan([bucket({ acl: 'public-read' })]);
    expect(findings[0].severity).toBe('critical');
  });

  it('escalates when every public access block is disabled', () => {
    const findings = inspectPlan([bucket({
      block_public_acls: false, block_public_policy: false,
      ignore_public_acls: false, restrict_public_buckets: false,
    })]);
    expect(findings[0].severity).toBe('critical');
  });

  it('flags a partial weakening at high rather than critical', () => {
    expect(inspectPlan([bucket({ block_public_acls: false })])[0].severity).toBe('high');
  });

  it('leaves a private bucket alone', () => {
    expect(inspectPlan([bucket({ acl: 'private', block_public_acls: true })])).toEqual([]);
  });
});

describe('data protection', () => {
  it('flags disabled backups as high', () => {
    const findings = inspectPlan([change({ after: { backup_retention_period: 0 } })]);
    expect(findings[0].severity).toBe('high');
    expect(findings[0].title).toMatch(/backups are disabled/i);
  });

  it('flags disabled deletion protection and skipped final snapshot', () => {
    const found = titles([change({ after: { deletion_protection: false, skip_final_snapshot: true } })]);
    expect(found).toHaveLength(2);
  });

  it('does not flag a healthy retention period', () => {
    expect(inspectPlan([change({ after: { backup_retention_period: 7 } })])).toEqual([]);
  });
});

describe('IAM breadth', () => {
  const role = (policy: unknown) =>
    change({ address: 'aws_iam_role_policy.app', resourceType: 'aws_iam_role_policy', after: { policy } });

  it('flags action and resource wildcards together as critical', () => {
    const findings = inspectPlan([role(JSON.stringify({
      Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
    }))]);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].title).toMatch(/every action on every resource/i);
  });

  it('flags a resource wildcard alone at high', () => {
    const findings = inspectPlan([role(JSON.stringify({
      Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
    }))]);
    expect(findings[0].severity).toBe('high');
  });

  it('accepts a scoped policy', () => {
    expect(inspectPlan([role(JSON.stringify({
      Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::bucket/*' }],
    }))])).toEqual([]);
  });

  it('reads a policy given as an object rather than a string', () => {
    expect(inspectPlan([role({ Statement: [{ Action: '*', Resource: '*' }] })])).toHaveLength(1);
  });

  it('does not inspect policies on unrelated resource types', () => {
    expect(inspectPlan([change({
      resourceType: 'aws_instance',
      after: { policy: '{"Action":"*","Resource":"*"}' },
    })])).toEqual([]);
  });
});

describe('stateful replacement', () => {
  it('warns that replacing a database destroys its data', () => {
    // The distinction this exists for: "1 to add, 1 to destroy" reads the same
    // for replacing a security group and for replacing a production database.
    const findings = inspectPlan([change({ action: 'replace' })]);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].title).toMatch(/DESTROYED and recreated/);
  });

  it('warns on deletion of a stateful resource', () => {
    const findings = inspectPlan([change({
      address: 'aws_s3_bucket.assets', resourceType: 'aws_s3_bucket', action: 'delete',
    })]);
    expect(findings[0].title).toMatch(/DESTROYED/);
  });

  it('stays quiet when a stateless resource is replaced', () => {
    expect(inspectPlan([change({
      address: 'aws_security_group.web', resourceType: 'aws_security_group', action: 'replace',
    })])).toEqual([]);
  });

  it('fires even when the plan carries no attribute values', () => {
    // A delete has no `after` at all, and that is exactly when data loss happens.
    expect(inspectPlan([change({ action: 'replace', after: undefined })])).toHaveLength(1);
  });
});

describe('ordering and summary', () => {
  it('puts the worst finding first', () => {
    const findings = inspectPlan([
      change({ address: 'a', after: { deletion_protection: false } }),        // medium
      change({ address: 'b', after: { publicly_accessible: true } }),          // critical
      change({ address: 'c', after: { backup_retention_period: 0 } }),         // high
    ]);
    expect(findings.map(f => f.severity)).toEqual(['critical', 'high', 'medium']);
  });

  it('summarises counts by severity', () => {
    const findings = inspectPlan([
      change({ address: 'a', after: { publicly_accessible: true, storage_encrypted: false } }),
      change({ address: 'b', after: { deletion_protection: false } }),
    ]);
    expect(summarizeFindings(findings)).toBe('2 critical, 1 medium');
  });

  it('says so plainly when there is nothing to report', () => {
    expect(summarizeFindings([])).toMatch(/No attribute-level risks/);
  });

  it('identifies a plan that should stop an approval', () => {
    expect(hasBlockingFindings(inspectPlan([change({ after: { publicly_accessible: true } })]))).toBe(true);
    expect(hasBlockingFindings(inspectPlan([change({ after: { deletion_protection: false } })]))).toBe(false);
  });
});

describe('robustness', () => {
  it('survives malformed attribute shapes', () => {
    // Plan JSON comes from whatever provider version the customer runs.
    expect(() => inspectPlan([
      change({ after: { ingress: 'not-a-list' } }),
      change({ after: { ingress: [null, 42] } as never }),
      change({ after: { acl: 12345 } as never }),
      change({ resourceType: 'aws_iam_role', after: { policy: '{ broken json' } }),
    ])).not.toThrow();
  });

  it('does not report redacted sensitive values as attributes', () => {
    // The executor replaces sensitive values with a marker; no rule should
    // interpret that string as a real setting.
    expect(inspectPlan([change({ after: { password: '[sensitive]', storage_encrypted: true } })])).toEqual([]);
  });
});
