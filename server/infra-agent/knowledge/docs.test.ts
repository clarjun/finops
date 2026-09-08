/**
 * The parsers decide what gets cited and what gets flagged as drift, and both
 * failure directions are quiet: a version matcher that is too loose cites the
 * wrong major version, and an argument extractor that is too eager reports
 * valid configuration as deprecated until people stop reading the warnings.
 */
import { describe, it, expect } from 'vitest';
import {
  satisfies, documentedArguments, emittedArguments, summarise, auditArguments,
  type ResourceDoc,
} from './docs';

describe('satisfies', () => {
  it('accepts any minor within the pinned major for ~>', () => {
    expect(satisfies('5.0.0', '~> 5.0')).toBe(true);
    expect(satisfies('5.100.0', '~> 5.0')).toBe(true);
  });

  it('rejects the next major', () => {
    // The whole point of the pin. `~> 5.0` matching 6.x would cite documentation
    // for a provider whose resources have different arguments.
    expect(satisfies('6.0.0', '~> 5.0')).toBe(false);
    expect(satisfies('4.67.0', '~> 5.0')).toBe(false);
  });

  it('fixes the minor when the constraint names a patch', () => {
    expect(satisfies('5.1.9', '~> 5.1.2')).toBe(true);
    expect(satisfies('5.1.1', '~> 5.1.2')).toBe(false);
    expect(satisfies('5.2.0', '~> 5.1.2')).toBe(false);
  });

  it('excludes pre-releases', () => {
    expect(satisfies('5.1.0-beta1', '~> 5.0')).toBe(false);
  });

  it('denies everything for a constraint form it does not understand', () => {
    // Failing closed. A permissive fallback would silently cite whatever the
    // registry returned first.
    expect(satisfies('5.1.0', '>= 5.0, < 6.0')).toBe(false);
    expect(satisfies('5.1.0', '5.1.0')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

const AWS_VPC_DOC = `---
subcategory: "VPC (Virtual Private Cloud)"
page_title: "AWS: aws_vpc"
---

# Resource: aws_vpc

Provides a VPC resource.

## Example Usage

\`\`\`terraform
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}
\`\`\`

## Argument Reference

This resource supports the following arguments:

* \`cidr_block\` - (Optional) The IPv4 CIDR block for the VPC.
* \`enable_dns_hostnames\` - (Optional) A boolean flag.
* \`tags\` - (Optional) A map of tags.

### timeouts

* \`create\` - (Default \`10m\`)

## Attribute Reference

* \`id\` - The ID of the VPC.
* \`arn\` - Amazon Resource Name.
`;

describe('documentedArguments', () => {
  it('reads the argument list', () => {
    const args = documentedArguments(AWS_VPC_DOC);
    expect(args).toContain('cidr_block');
    expect(args).toContain('enable_dns_hostnames');
    expect(args).toContain('tags');
  });

  it('stops at the next top-level heading', () => {
    // `id` and `arn` are attributes, not arguments. Including them would make
    // the audit accept configuration that sets a read-only field.
    const args = documentedArguments(AWS_VPC_DOC);
    expect(args).not.toContain('id');
    expect(args).not.toContain('arn');
  });

  it('keeps nested block sections, which sit under ###', () => {
    expect(documentedArguments(AWS_VPC_DOC)).toContain('create');
  });

  it('returns nothing when there is no argument section', () => {
    expect(documentedArguments('# Resource: aws_thing\n\nNo arguments here.')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

const HCL = `resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true

  tags = {
    Name        = "primary"
    Environment = "prod"
  }

  lifecycle {
    prevent_destroy = true
  }
}`;

describe('emittedArguments', () => {
  it('reads only the resource-level arguments', () => {
    expect(emittedArguments(HCL).sort())
      .toEqual(['cidr_block', 'enable_dns_hostnames', 'lifecycle', 'tags']);
  });

  it('does not descend into maps or nested blocks', () => {
    // `Name` inside tags and `prevent_destroy` inside lifecycle are not
    // arguments of aws_vpc; reporting them would flag every tagged resource.
    const args = emittedArguments(HCL);
    expect(args).not.toContain('Name');
    expect(args).not.toContain('Environment');
    expect(args).not.toContain('prevent_destroy');
  });

  it('handles a list-valued argument without losing depth', () => {
    const hcl = `resource "aws_x" "y" {
  subnets = [
    "a",
    "b",
  ]
  name = "z"
}`;
    expect(emittedArguments(hcl).sort()).toEqual(['name', 'subnets']);
  });
});

/* -------------------------------------------------------------------------- */

const doc = (args: string[]): ResourceDoc => ({
  provider: 'aws', resourceType: 'aws_vpc', version: '5.100.0',
  url: 'https://registry.terraform.io/providers/hashicorp/aws/5.100.0/docs/resources/vpc',
  title: 'vpc', subcategory: null, excerpt: '', arguments: args,
});

describe('auditArguments', () => {
  it('is silent when everything we emit is documented', () => {
    const report = auditArguments(HCL, doc(['cidr_block', 'enable_dns_hostnames', 'tags', 'prevent_destroy']));
    expect(report.undocumented).toEqual([]);
    expect(report.checked).toBe(4);
  });

  it('reports an argument the current documentation does not list', () => {
    const report = auditArguments(HCL, doc(['cidr_block', 'tags', 'prevent_destroy']));
    expect(report.undocumented).toEqual(['enable_dns_hostnames']);
  });

  it('never flags Terraform meta-arguments', () => {
    // `lifecycle` is Terraform's, not the provider's; no document lists it.
    const report = auditArguments(HCL, doc(['cidr_block', 'enable_dns_hostnames', 'tags']));
    expect(report.undocumented).not.toContain('lifecycle');
  });

  it('reports nothing when the argument list could not be parsed', () => {
    // An unparsed document is an absence of evidence. Treating it as evidence
    // of absence would flag every argument on the resource.
    expect(auditArguments(HCL, doc([])).undocumented).toEqual([]);
  });

  it('carries the exact version it checked against', () => {
    expect(auditArguments(HCL, doc(['cidr_block'])).version).toBe('5.100.0');
  });
});

describe('summarise', () => {
  it('drops front matter, headings and code fences', () => {
    const text = summarise(AWS_VPC_DOC);
    expect(text).toContain('Provides a VPC resource.');
    expect(text).not.toContain('subcategory:');
    expect(text).not.toContain('# Resource');
  });

  it('truncates rather than storing a whole document', () => {
    const long = `---\nx: y\n---\n\n${'word '.repeat(500)}`;
    expect(summarise(long, 100).length).toBeLessThanOrEqual(100);
  });
});
