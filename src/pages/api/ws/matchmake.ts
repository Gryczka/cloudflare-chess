/**
 * `GET /api/ws/matchmake?time=<ms>&username=<name>` — WebSocket upgrade entry
 * point for matchmaking. Rate-limited per IP (QR-9) before the upgrade is
 * attempted, then the request is forwarded as-is to the `Matchmaker`
 * singleton Durable Object, which performs the actual upgrade and queuing.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { isAllowed } from '../../../lib/rate-limit';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
	if (request.headers.get('Upgrade') !== 'websocket') {
		return new Response('Expected WebSocket upgrade', { status: 426 });
	}

	const ip = request.headers.get('CF-Connecting-IP') ?? '127.0.0.1';
	if (!await isAllowed(env.RATE_LIMIT_LOGIN, ip)) {
		return Response.json({ error: 'rate_limited' }, { status: 429 });
	}

	return env.MATCHMAKER.getByName('global').fetch(request);
};
