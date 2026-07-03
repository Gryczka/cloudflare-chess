/**
 * `POST /api/enroll` — create a new anonymous account, or refresh the session
 * for an already-enrolled player.
 *
 * Guarded by Rate Limiting (QR-9, `RATE_LIMIT_ENROLL`) and Turnstile
 * (bot-farming protection); both are no-ops when their bindings/secrets are
 * unconfigured, so local dev works without setup. On success, sets a signed
 * session cookie (see `lib/identity.ts`) and returns the player's handle and
 * profile. The recovery secret (`cfk_…`) is included in the response ONLY
 * for brand-new accounts — it is never re-issued or recoverable afterward.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createSessionCookie, isRequestSecure, resolvePlayerId, safeUsername } from '../../lib/identity';
import { isAllowed } from '../../lib/rate-limit';
import { verifyTurnstile } from '../../lib/turnstile';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
	const ip = request.headers.get('CF-Connecting-IP') ?? '127.0.0.1';

	if (!await isAllowed(env.RATE_LIMIT_ENROLL, ip)) {
		return Response.json({ error: 'rate_limited' }, { status: 429 });
	}

	// Parse body BEFORE verifyTurnstile — the request body stream can only be
	// consumed once, so we extract turnstileToken here for use below.
	let username = '';
	let turnstileToken: string | undefined;
	try {
		const body = (await request.json()) as { username?: unknown; turnstileToken?: unknown };
		if (typeof body?.username === 'string') username = body.username;
		if (typeof body?.turnstileToken === 'string') turnstileToken = body.turnstileToken;
	} catch {
		// Body is optional.
	}

	if (!await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET_KEY, ip)) {
		return Response.json({ error: 'turnstile_failed' }, { status: 403 });
	}

	const secure = isRequestSecure(request);
	const matchmaker = env.MATCHMAKER.getByName('global');
	const existing = await resolvePlayerId(request, env.AUTH_SECRET);

	if (existing) {
		const bundle = await matchmaker.getProfileBundle(existing, 10);
		if (bundle) {
			// Already enrolled — refresh the session, never re-issue a secret.
			return Response.json(
				{ playerId: existing, profile: bundle.profile },
				{ headers: { 'Set-Cookie': await createSessionCookie(existing, env.AUTH_SECRET, { secure }) } },
			);
		}
	}

	// New account: the secret is returned exactly once, here.
	const enrolled = await matchmaker.mintPlayerId(safeUsername(username));
	return Response.json(enrolled, {
		status: 201,
		headers: { 'Set-Cookie': await createSessionCookie(enrolled.playerId, env.AUTH_SECRET, { secure }) },
	});
};
