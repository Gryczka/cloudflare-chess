// Cloudflare Workers Rate Limiting API wrapper (QR-9).
// The `isAllowed` function is a no-op when a deployment intentionally omits
// the binding; Wrangler provides local simulations for configured bindings.

/**
 * Returns true when the request should be allowed, false when it should be
 * rejected (rate limited). If `limiter` is not configured (undefined/null),
 * the check is skipped and the request is always allowed.
 *
 * NOTE: key is typically the client IP from CF-Connecting-IP.
 */
export async function isAllowed(limiter: RateLimit | undefined | null, key: string): Promise<boolean> {
	if (!limiter) return true;
	const outcome = await limiter.limit({ key });
	return outcome.success;
}
