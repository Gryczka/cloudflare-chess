// P3-A: GET /api/match/:id/pgn — returns PGN as plain text for download.
// No auth required — finished games are public read (same as the match page).
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
	const matchId = params.id ?? '';
	if (!matchId) return new Response('Missing match ID', { status: 400 });

	const result = await env.CHESS_MATCH.getByName(matchId).getPgn();
	if ('status' in result) return new Response('Match not found', { status: 404 });

	return new Response(result.pgn, {
		headers: {
			'Content-Type': 'application/x-chess-pgn',
			'Content-Disposition': `attachment; filename="match-${matchId.slice(0, 8)}.pgn"`,
			'Cache-Control': 'public, max-age=86400, immutable',
		},
	});
};
