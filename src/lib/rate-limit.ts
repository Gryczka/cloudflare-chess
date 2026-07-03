// Cloudflare Workers Rate Limiting API wrapper (QR-9).
// The `isAllowed` function is a no-op (returns true) when the binding is absent,
// so local dev and CI stay green without real rate-limit bindings configured.
// In production set real namespace_id values in wrangler.jsonc and deploy.

export type RateLimiter = {
	limit(opts: { key: string }): Promise<{ limited: boolean }>;
};

/**
 * Returns true when the request should be allowed, false when it should be
 * rejected (rate limited). If `limiter` is not configured (undefined/null),
 * the check is skipped and the request is always allowed.
 *
 * NOTE: key is typically the client IP from CF-Connecting-IP. In local dev
 * all requests share '127.0.0.1' — do NOT configure real rate-limit bindings
 * in wrangler.jsonc locally or sequential tests will interfere with each other.
 */
export async function isAllowed(limiter: RateLimiter | undefined | null, key: string): Promise<boolean> {
	if (!limiter) return true;
	const outcome = await limiter.limit({ key });
	return !outcome.limited;
}
