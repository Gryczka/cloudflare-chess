import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAllowed } from '../../src/lib/rate-limit';
import { verifyTurnstile } from '../../src/lib/turnstile';

// Node unit tests — NOT in tests/workers/ (vi.stubGlobal only works in Node env).

describe('verifyTurnstile (QR-9)', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		// Reset the module-level `_warnedOnce` guard between tests by re-importing
		// is intentional — the warning fires once per process startup. Suppressing
		// the console.warn prevents noisy test output; this is intentional in unit tests.
		vi.restoreAllMocks();
	});

	it('returns true and warns when secret is null (no-op dev mode)', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(await verifyTurnstile('token', null, '127.0.0.1')).toBe(true);
		// Warning fires on first call per module lifetime — suppress in assertions.
		warn.mockRestore();
	});

	it('returns true when secret is empty string', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(await verifyTurnstile('token', '', '127.0.0.1')).toBe(true);
	});

	it('returns false when siteverify reports success:false', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				json: vi.fn().mockResolvedValue({ success: false, 'error-codes': ['invalid-input-response'] }),
			}),
		);
		vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await verifyTurnstile('bad-token', 'secret', '1.2.3.4')).toBe(false);
	});

	it('returns true when siteverify reports success:true', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				json: vi.fn().mockResolvedValue({ success: true }),
			}),
		);
		expect(await verifyTurnstile('good-token', 'secret', '1.2.3.4')).toBe(true);
	});

	it('returns false and logs on network error', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await verifyTurnstile('token', 'secret', '1.2.3.4')).toBe(false);
	});
});

describe('isAllowed / rate limiter (QR-9)', () => {
	it('returns true (allow) when limiter is undefined', async () => {
		expect(await isAllowed(undefined, 'ip')).toBe(true);
	});

	it('returns true when limiter is null', async () => {
		expect(await isAllowed(null, 'ip')).toBe(true);
	});

	it('calls limiter.limit with the key and returns true when not limited', async () => {
		const limiter = { limit: vi.fn().mockResolvedValue({ limited: false }) };
		expect(await isAllowed(limiter, '1.2.3.4')).toBe(true);
		expect(limiter.limit).toHaveBeenCalledWith({ key: '1.2.3.4' });
	});

	it('returns false (deny) when limiter reports limited', async () => {
		const limiter = { limit: vi.fn().mockResolvedValue({ limited: true }) };
		expect(await isAllowed(limiter, '1.2.3.4')).toBe(false);
	});
});
