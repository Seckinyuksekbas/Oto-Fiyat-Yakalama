import { describe, expect, it } from 'vitest';
import { NOTIFY_JOB_OPTS, RETRYING_JOB_OPTS } from './job-options';

describe('job options', () => {
  it('keeps failed notify jobs for 7 days so admins can retry them', () => {
    expect(NOTIFY_JOB_OPTS.removeOnFail).toEqual({ age: 7 * 86400 });
  });
  it('keeps failed retrying jobs for 24 hours', () => {
    expect(RETRYING_JOB_OPTS.removeOnFail).toEqual({ age: 86400 });
  });
});
