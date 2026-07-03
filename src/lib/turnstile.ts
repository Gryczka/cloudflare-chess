// Cloudflare Turnstile server-side verification (QR-9).
// When TURNSTILE_SECRET_KEY is absent/empty (local dev, CI) the guard is a
// no-op — it returns true and logs a warning so the absence is visible.
// In production set the secret via: npx wrangler secret put TURNSTILE_SECRET_KEY

let _warnedOnce = false;

/**
 * Verify a Cloudflare Turnstile token against the siteverify endpoint.
 *
 * @param token - The `cf-turnstile-response` token submitted by the client.
 * @param secret - The Turnstile secret key. When falsy, verification is
 *   skipped (returns `true`) so local dev/CI stay green without a real key.
 * @param ip - The client IP (`CF-Connecting-IP`), forwarded to Turnstile for
 *   additional signal.
 * @returns `true` if the token is valid (or verification is disabled).
 */
export async function verifyTurnstile(
	token: string | null | undefined,
	secret: string | null | undefined,
	ip: string,
): Promise<boolean> {
	if (!secret) {
		if (!_warnedOnce) {
			_warnedOnce = true;
			console.warn(
				'[cf-chess] TURNSTILE_SECRET_KEY is unset — Turnstile verification is disabled. Set the key in production to protect account creation.',
			);
		}
		return true;
	}

	try {
		const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ secret, response: token ?? '', remoteip: ip }),
		});
		const data = (await response.json()) as { success?: unknown; 'error-codes'?: string[] };
		if (data.success !== true) {
			console.error('[cf-chess] Turnstile verification failed', data['error-codes']);
		}
		return data.success === true;
	} catch (err) {
		console.error('[cf-chess] Turnstile network error', err);
		return false;
	}
}
