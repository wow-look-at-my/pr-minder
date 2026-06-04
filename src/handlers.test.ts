import { describe, it, expect } from 'vitest';
import { conditionMet, isActionsBotPr, shouldSkipBranch } from './handlers';

const noApprovers = async () => new Set<string>();
const approvers = (...names: string[]) => async () => new Set(names);
const pr = (labels: string[]) => ({ labels: labels.map((name) => ({ name })) });

describe('conditionMet', () => {
  describe('label', () => {
    it('matches when PR has the label', async () => {
      expect(await conditionMet({ label: 'auto-pr-update' }, pr(['auto-pr-update']), noApprovers)).toBe(true);
    });

    it('fails when PR lacks the label', async () => {
      expect(await conditionMet({ label: 'auto-pr-update' }, pr(['other']), noApprovers)).toBe(false);
    });

    it('fails when PR has no labels', async () => {
      expect(await conditionMet({ label: 'auto-pr-update' }, pr([]), noApprovers)).toBe(false);
    });
  });

  describe('approved_by', () => {
    it('matches when any listed user approved', async () => {
      expect(await conditionMet({ approved_by: ['alice', 'bob'] }, pr([]), approvers('bob'))).toBe(true);
    });

    it('fails when no listed user approved', async () => {
      expect(await conditionMet({ approved_by: ['alice'] }, pr([]), approvers('charlie'))).toBe(false);
    });

    it('fails with no approvals', async () => {
      expect(await conditionMet({ approved_by: ['alice'] }, pr([]), noApprovers)).toBe(false);
    });
  });

  describe('min_approvals', () => {
    it('matches when approval count meets threshold', async () => {
      expect(await conditionMet({ min_approvals: 2 }, pr([]), approvers('alice', 'bob'))).toBe(true);
    });

    it('matches at exact threshold', async () => {
      expect(await conditionMet({ min_approvals: 1 }, pr([]), approvers('alice'))).toBe(true);
    });

    it('fails when approval count is below threshold', async () => {
      expect(await conditionMet({ min_approvals: 2 }, pr([]), approvers('alice'))).toBe(false);
    });
  });

  describe('AND across keys', () => {
    it('requires all keys to pass', async () => {
      const condition = { label: 'auto-pr-update', min_approvals: 2 };
      expect(await conditionMet(condition, pr(['auto-pr-update']), approvers('a', 'b'))).toBe(true);
      expect(await conditionMet(condition, pr(['auto-pr-update']), approvers('a'))).toBe(false);
      expect(await conditionMet(condition, pr([]), approvers('a', 'b'))).toBe(false);
    });

    it('approved_by and min_approvals together require both', async () => {
      const condition = { approved_by: ['alice'], min_approvals: 2 };
      expect(await conditionMet(condition, pr([]), approvers('alice', 'bob'))).toBe(true);
      expect(await conditionMet(condition, pr([]), approvers('alice'))).toBe(false);
      expect(await conditionMet(condition, pr([]), approvers('bob', 'charlie'))).toBe(false);
    });
  });

  it('empty condition (no keys) passes trivially', async () => {
    expect(await conditionMet({}, pr([]), noApprovers)).toBe(true);
  });
});

describe('isActionsBotPr', () => {
  it('is true for a PR authored by github-actions[bot]', () => {
    expect(isActionsBotPr({ user: { login: 'github-actions[bot]' } })).toBe(true);
  });

  it('is false for a human author', () => {
    expect(isActionsBotPr({ user: { login: 'alice' } })).toBe(false);
  });

  it('is false for other bots (e.g. dependabot, which does trigger its own workflows)', () => {
    expect(isActionsBotPr({ user: { login: 'dependabot[bot]' } })).toBe(false);
  });

  it('is false when the author is missing', () => {
    expect(isActionsBotPr({})).toBe(false);
    expect(isActionsBotPr(undefined)).toBe(false);
  });
});

describe('shouldSkipBranch', () => {
  it('always skips the base branch and gh-pages', () => {
    expect(shouldSkipBranch('main', 'main', [])).toBe(true);
    expect(shouldSkipBranch('gh-pages', 'main', [])).toBe(true);
  });

  it('skips branches in the configured skip list', () => {
    expect(shouldSkipBranch('staging', 'main', ['staging', 'release'])).toBe(true);
    expect(shouldSkipBranch('release', 'main', ['staging', 'release'])).toBe(true);
  });

  it('does not skip an ordinary feature branch', () => {
    expect(shouldSkipBranch('feature/x', 'main', ['staging'])).toBe(false);
  });
});
