/**
 * `GET /api/ws/match/[id]` — WebSocket upgrade entry point for a specific
 * game. Simply forwards the request to the `ChessMatch` Durable Object
 * identified by the match id; that DO determines the caller's role (player
 * vs. spectator) from their session cookie during its own `fetch()` handler.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const GET: APIRoute = ({ request, params }) => {
	if (request.headers.get('Upgrade') !== 'websocket') {
		return new Response('Expected WebSocket upgrade', { status: 426 });
	}

	if (!params.id) {
		return new Response('Missing match id', { status: 400 });
	}

	return env.CHESS_MATCH.getByName(params.id).fetch(request);
};
