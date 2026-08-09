import { describe, it, expect } from 'vitest';
import { extractFragment, stepSlug } from './step-library';

const HCL = `
resource "aws_vpc" "network_vpc" {
  cidr_block = "10.0.0.0/16"
  tags = {
    Name = "ecom-vpc"
  }
}

resource "aws_s3_bucket" "storage_object" {
  bucket = "\${var.name_prefix}-assets"
  tags = {
    Name = "ecom-bucket"
  }
}

resource "aws_security_group" "app_sg" {
  name = "sg"
  ingress {
    from_port = 443
    to_port   = 443
  }
  egress {
    from_port = 0
  }
}
`;

describe('step identity', () => {
  it('is stable for the same resource on the same cloud', () => {
    expect(stepSlug('aws', 'OBJECT_STORAGE', 'aws_s3_bucket'))
      .toBe(stepSlug('aws', 'OBJECT_STORAGE', 'aws_s3_bucket'));
  });

  it('distinguishes providers and logical types', () => {
    expect(stepSlug('aws', 'NETWORK', 'aws_vpc')).not.toBe(stepSlug('azure', 'NETWORK', 'azurerm_virtual_network'));
    expect(stepSlug('aws', 'NETWORK', 'aws_vpc')).not.toBe(stepSlug('aws', 'OBJECT_STORAGE', 'aws_s3_bucket'));
  });

  it('produces a slug safe to use as an identifier', () => {
    expect(stepSlug('aws', 'MANAGED_POSTGRES', 'aws_db_instance')).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('HCL fragment extraction', () => {
  it('extracts a whole resource block', () => {
    const fragment = extractFragment(HCL, 'aws_vpc.network_vpc');
    expect(fragment).toContain('resource "aws_vpc" "network_vpc"');
    expect(fragment).toContain('cidr_block');
    expect(fragment.trim().endsWith('}')).toBe(true);
  });

  it('keeps nested blocks intact', () => {
    // Brace counting, not a regex. A non-greedy match to the first closing brace
    // would truncate at the end of `ingress {`, storing a fragment that is not
    // valid HCL — and the library would then hand that to a future deployment.
    const fragment = extractFragment(HCL, 'aws_security_group.app_sg');
    expect(fragment).toContain('ingress {');
    expect(fragment).toContain('egress {');
    expect(countBraces(fragment)).toBe(0);
  });

  it('does not swallow the following resource', () => {
    const fragment = extractFragment(HCL, 'aws_vpc.network_vpc');
    expect(fragment).not.toContain('aws_s3_bucket');
  });

  it('preserves escaped interpolation, so a stored step stays safe', () => {
    const fragment = extractFragment(HCL, 'aws_s3_bucket.storage_object');
    expect(fragment).toContain('${var.name_prefix}');
  });

  it('returns empty rather than guessing when the address is absent', () => {
    expect(extractFragment(HCL, 'aws_db_instance.nope')).toBe('');
  });

  it('is balanced for every resource in a real config', () => {
    for (const address of ['aws_vpc.network_vpc', 'aws_s3_bucket.storage_object', 'aws_security_group.app_sg']) {
      expect(countBraces(extractFragment(HCL, address)), address).toBe(0);
    }
  });
});

function countBraces(s: string): number {
  let depth = 0;
  for (const ch of s) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  return depth;
}

describe('stepSlug variants', () => {
  it('separates resources of one type built in different roles', () => {
    // A public and a private subnet are the same resource type configured
    // deliberately differently. Sharing one identity meant the library could
    // only ever hold one of them, and the other looked like a revision.
    const publicSubnet = stepSlug('aws', 'SUBNET', 'aws_subnet', 'public');
    const privateSubnet = stepSlug('aws', 'SUBNET', 'aws_subnet', 'private');

    expect(publicSubnet).not.toBe(privateSubnet);
    // Underscores are normalised to hyphens, so the slug stays URL-safe.
    expect(publicSubnet).toBe('aws-subnet-aws-subnet-public');
  });

  it('is unchanged for a resource with no role', () => {
    // A VPC has no variant, and adding one would rename every step already
    // recorded against the old identity.
    expect(stepSlug('aws', 'NETWORK', 'aws_vpc')).toBe(stepSlug('aws', 'NETWORK', 'aws_vpc', null));
  });

  it('stays stable for the same inputs', () => {
    expect(stepSlug('aws', 'SUBNET', 'aws_subnet', 'public'))
      .toBe(stepSlug('aws', 'SUBNET', 'aws_subnet', 'public'));
  });
});
