import { describe, expect, it } from 'vitest';
import { describeRelease, greetingPath, shortVersion } from '../src/release.js';

const sha = '0123456789abcdef0123456789abcdef01234567';

describe('release', () => {
  it('shortens commit SHAs only', () => {
    expect(shortVersion(sha)).toBe('0123456');
    expect(shortVersion('dev')).toBe('dev');
  });

  it('describes both halves of the release', () => {
    expect(describeRelease(sha, { version: sha, environment: 'staging' })).toBe(
      'frontend 0123456 · backend 0123456 (staging)',
    );
  });

  it('says when the backend is unreachable', () => {
    expect(describeRelease('dev', undefined)).toBe('frontend dev · backend unreachable');
  });

  it('encodes the name in the greeting path', () => {
    expect(greetingPath(' Ada & Bo ')).toBe('/api/greeting?name=Ada+%26+Bo');
  });
});
