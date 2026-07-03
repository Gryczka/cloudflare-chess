// P4-A: GET /api/match/:id/eval?fen=... — evaluate a FEN position using the
// engine running inside the ChessMatch DO. Returns centipawn score from white's
// perspective. Used by the eval bar in the match UI and post-game analysis.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const GET: APIRoute = async ({ params, request }) => {
	const matchId = params.id ?? '';
	if (!matchId) return new Response('Missing match ID', { status: 400 });

	const url = new URL(request.url);
	const fen = url.searchParams.get('fen');
	if (!fen) return new Response('Missing fen param', { status: 400 });

	try {
		const result = await env.CHESS_MATCH.getByName(matchId).getEval(fen);
		return Response.json(result, {
			headers: { 'Cache-Control': 'private, max-age=30' },
		});
	} catch {
		return new Response('Eval failed', { status: 500 });
	}
};
