import { afterEach } from 'vitest';
import { resetRateLimitersForTests } from '../server/rateLimiter';

// The production request ceiling is process-wide. Reset its in-memory window
// between tests so unrelated HTTP fixtures cannot consume one another's budget.
afterEach(() => resetRateLimitersForTests());
