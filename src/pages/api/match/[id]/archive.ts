// P3-C: GET /api/match/:id/archive — returns the JSON game record from R2.
// Falls back to the live DO if the R2 object is not found yet (game just ended).
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
	const matchId = params.id ?? '';
	if (!matchId) return new Response('Missing match ID', { status: 400 });

	// Try R2 first (fast, cached, works after DO cleanup).
	if (env.R2_ARCHIVE) {
		const obj = await env.R2_ARCHIVE.get(`games/${matchId}.json`);
		if (obj) {
			return new Response(obj.body, {
				headers: {
					'Content-Type': 'application/json',
					'Cache-Control': 'public, max-age=86400, immutable',
				},
			});
		}
	}

	// Fall back to live DO (game may not be archived yet).
	try {
		const state = await env.CHESS_MATCH.getByName(matchId).getState();
		if ('status' in state && state.status === 'not_found') {
			return new Response('Match not found', { status: 404 });
		}
		return Response.json(state, {
			headers: { 'Cache-Control': 'no-store' },
		});
	} catch {
		return new Response('Match not found', { status: 404 });
	}
};
