import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createSessionCookie, isRequestSecure, resolvePlayerId, safeUsername } from '../../../lib/identity';
import { isTimeControl } from '../../../lib/messages';
import { isBotDifficulty } from '../../../lib/chess/bot';
import { isAllowed } from '../../../lib/rate-limit';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
	const ip = request.headers.get('CF-Connecting-IP') ?? '127.0.0.1';

	if (!await isAllowed(env.RATE_LIMIT_ENROLL, ip)) {
		return Response.json({ error: 'rate_limited' }, { status: 429 });
	}

	let body: { username?: string; timeControlMs?: number; difficulty?: unknown } = {};

	try {
		body = await request.json();
	} catch {
		return new Response('Expected JSON body', { status: 400 });
	}

	const timeControlMs = Number(body.timeControlMs);
	if (!isTimeControl(timeControlMs)) return new Response('Unsupported time control', { status: 400 });
	const difficulty = isBotDifficulty(body.difficulty) ? body.difficulty : 'knight';

	const matchmaker = env.MATCHMAKER.getByName('global');
	let playerId = await resolvePlayerId(request, env.AUTH_SECRET);
	let secret: string | undefined;
	let setCookie: string | undefined;
	if (!playerId) {
		const enrolled = await matchmaker.mintPlayerId(safeUsername(body.username));
		playerId = enrolled.playerId;
		secret = enrolled.secret;
		setCookie = await createSessionCookie(playerId, env.AUTH_SECRET, { secure: isRequestSecure(request) });
	}

	const match = await matchmaker.createBotMatch(
		playerId,
		safeUsername(body.username),
		timeControlMs,
		difficulty,
	);

	// `secret` is present only when we just minted a new account — surfaced once.
	return Response.json(secret ? { ...match, secret } : match, {
		headers: setCookie ? { 'Set-Cookie': setCookie } : undefined,
	});
};
