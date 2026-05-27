import { describe, it, expect } from 'vitest';
import { handle } from './handlers';

// handlers.ts integration behaviour is covered by the e2e webhook tests in worker.test.ts.
// Unit-testable pure logic currently lives in config.test.ts.
describe('handlers', () => {
  it('exports handle', () => {
    expect(typeof handle).toBe('function');
  });
});
