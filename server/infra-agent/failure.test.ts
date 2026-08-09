/**
 * The classifier decides whether the system runs an operation against someone's
 * cloud account again. Both mistakes are expensive: retrying a permanent error
 * wastes a deployment window, and refusing to retry a throttle abandons a
 * half-built environment that would have succeeded after two seconds.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyFailure, shouldRetry, retryDelayMs, terminalStatusFor, MAX_ATTEMPTS,
} from './failure';

describe('classifyFailure — transient', () => {
  it('recognises AWS throttling', () => {
    const c = classifyFailure('Error: RequestLimitExceeded: Request limit exceeded.');
    expect(c.kind).toBe('transient');
    expect(c.retryable).toBe(true);
  });

  it('does not read a throttle as an exhausted quota', () => {
    // `RequestLimitExceeded` contains "LimitExceeded", which is how quota errors
    // read. Classified the other way round, every throttle would stop the
    // deployment instead of waiting and succeeding — so rule order is load
    // bearing and this is the test that holds it in place.
    expect(classifyFailure('RequestLimitExceeded').kind).toBe('transient');
    expect(classifyFailure('VcpuLimitExceeded: You have requested more vCPU capacity').kind).toBe('blocked');
  });

  it('recognises timeouts', () => {
    expect(classifyFailure('Error: timeout while waiting for state to become available').kind).toBe('transient');
    expect(classifyFailure('context deadline exceeded').kind).toBe('transient');
  });

  it('recognises provider-side internal errors', () => {
    expect(classifyFailure('InternalError: We encountered an internal error. Please try again.').kind).toBe('transient');
  });

  it('recognises eventual consistency', () => {
    // The resource exists; the API that needs it cannot see it yet. Waiting is
    // the documented fix, not a config change.
    expect(classifyFailure('InvalidGroup.NotFound: The security group does not exist').kind).toBe('transient');
    expect(classifyFailure('the subnet is not yet available').kind).toBe('transient');
  });

  it('recognises a dropped connection', () => {
    expect(classifyFailure('read tcp 10.0.0.1:443: connection reset by peer').kind).toBe('transient');
  });
});

describe('classifyFailure — blocked', () => {
  it('recognises a quota', () => {
    const c = classifyFailure('AddressLimitExceeded: The maximum number of addresses has been reached.');
    expect(c.kind).toBe('blocked');
    expect(c.retryable).toBe(false);
  });

  it('recognises missing permissions', () => {
    expect(classifyFailure('AccessDenied: User is not authorized to perform: ec2:CreateVpc').kind).toBe('blocked');
    expect(classifyFailure('UnauthorizedOperation').kind).toBe('blocked');
  });

  it('recognises expired credentials', () => {
    expect(classifyFailure('ExpiredToken: The security token included in the request is expired').kind).toBe('blocked');
  });

  it('recognises no capacity for the instance type', () => {
    // Retrying immediately will not help, but it is not a configuration fault
    // either — the region may have capacity in an hour.
    expect(classifyFailure('InsufficientInstanceCapacity').kind).toBe('blocked');
  });
});

describe('classifyFailure — permanent', () => {
  it('recognises an invalid parameter', () => {
    const c = classifyFailure('InvalidParameterValue: Invalid DB instance class: db.t9.enormous');
    expect(c.kind).toBe('permanent');
    expect(c.retryable).toBe(false);
  });

  it('recognises a name already taken', () => {
    expect(classifyFailure('BucketAlreadyOwnedByYou: Your previous request to create the named bucket succeeded').kind)
      .toBe('permanent');
  });

  it('recognises something the provider does not offer here', () => {
    expect(classifyFailure('Unsupported: The requested configuration is not supported in this region').kind)
      .toBe('permanent');
  });

  it('recognises a broken configuration', () => {
    expect(classifyFailure('Error: Unsupported argument. An argument named "foo" is not expected here.').kind)
      .toBe('permanent');
  });
});

describe('classifyFailure — unknown', () => {
  it('does not guess', () => {
    const c = classifyFailure('Error: something nobody has seen before');
    expect(c.kind).toBe('unknown');
    // Not knowing what went wrong is the worst possible reason to do it again.
    expect(c.retryable).toBe(false);
  });

  it('handles empty input without throwing', () => {
    expect(classifyFailure('').kind).toBe('unknown');
    expect(classifyFailure(undefined as unknown as string).kind).toBe('unknown');
  });

  it('explains itself', () => {
    // The reason is shown to whoever has to deal with the paused run.
    expect(classifyFailure('RequestLimitExceeded').reason).toMatch(/throttl/i);
    expect(classifyFailure('AccessDenied').reason).toMatch(/permitted/i);
  });
});

describe('shouldRetry', () => {
  const transient = classifyFailure('RequestLimitExceeded');
  const permanent = classifyFailure('InvalidParameterValue');

  it('retries a transient failure within the limit', () => {
    expect(shouldRetry(transient, 1)).toBe(true);
    expect(shouldRetry(transient, MAX_ATTEMPTS - 1)).toBe(true);
  });

  it('stops at the limit', () => {
    expect(shouldRetry(transient, MAX_ATTEMPTS)).toBe(false);
  });

  it('never retries a permanent failure, even on the first attempt', () => {
    expect(shouldRetry(permanent, 1)).toBe(false);
  });

  it('never retries an unrecognised failure', () => {
    expect(shouldRetry(classifyFailure('mystery'), 1)).toBe(false);
  });
});

describe('retryDelayMs', () => {
  it('backs off rather than hammering', () => {
    // Retrying a throttle immediately is how a client turns provider throttling
    // into provider blocking.
    expect(retryDelayMs(1)).toBeLessThan(retryDelayMs(2));
    expect(retryDelayMs(2)).toBeLessThan(retryDelayMs(3));
  });

  it('stays well inside the five-minute run lease', () => {
    // A wait longer than the lease would let a second worker take the run over
    // while the first is still sleeping mid-retry.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS + 2; attempt++) {
      expect(retryDelayMs(attempt)).toBeLessThan(60_000);
    }
  });
});

describe('terminalStatusFor', () => {
  it('fails only when the configuration must change', () => {
    expect(terminalStatusFor('permanent')).toBe('failed');
  });

  it('pauses when the cause can be fixed outside the system', () => {
    // A quota increase or a permission grant makes the same plan work. Calling
    // that "failed" strands a half-built environment and suggests there is
    // nothing left to do.
    expect(terminalStatusFor('blocked')).toBe('paused');
    expect(terminalStatusFor('unknown')).toBe('paused');
  });
});
