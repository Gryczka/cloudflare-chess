import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createSessionCookie, isRequestSecure } from '../../lib/identity';
import { isValidSecret } from '../../lib/player-id';
import { isAllowed } from '../../lib/rate-limit';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
	const ip = request.headers.get('CF-Connecting-IP') ?? '127.0.0.1';

	if (!await isAllowed(env.RATE_LIMIT_LOGIN, ip)) {
		return Response.json({ error: 'rate_limited' }, { status: 429 });
	}

	let secret = '';
	try {
		const body = (await request.json()) as { secret?: unknown };
		if (typeof body?.secret === 'string') secret = body.secret.trim();
	} catch {
		return new Response('Expected JSON body', { status: 400 });
	}

	if (!isValidSecret(secret)) return new Response('Invalid recovery key', { status: 400 });
	const result = await env.MATCHMAKER.getByName('global').loginWithSecret(secret);
	if (!result) return new Response('Unknown recovery key', { status: 401 });

	// Never echo the secret back; just establish the signed session.
	return Response.json(
		{ playerId: result.playerId, profile: result.profile },
		{ headers: { 'Set-Cookie': await createSessionCookie(result.playerId, env.AUTH_SECRET, { secure: isRequestSecure(request) }) } },
	);
};
