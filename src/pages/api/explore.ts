/**
 * `GET /api/explore?fen=<FEN>&limit=<n>` — top continuations played from a
 * given position, aggregated across all indexed games. Powers the opening
 * explorer at `/explore`. Lightly cached at the edge (30-60s) since position
 * statistics change slowly.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getContinuations } from '../../lib/d1/positions';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
	const fen = url.searchParams.get('fen');
	if (!fen) return new Response('Missing fen param', { status: 400 });

	const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit') ?? 10)));

	try {
		const continuations = await getContinuations(env.DB, fen, limit);
		return Response.json({ fen, continuations }, {
			headers: { 'Cache-Control': 'public, s-maxage=60, max-age=30' },
		});
	} catch (error) {
		return Response.json({ fen, continuations: [], error: String(error) });
	}
};
