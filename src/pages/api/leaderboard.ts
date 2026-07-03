// P4-B: GET /api/leaderboard — serves from KV cache (60s TTL), falls back to D1.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import type { LeaderboardEntry } from '../../lib/messages';

export const prerender = false;

const CACHE_TTL = 60; // seconds
const CACHE_KEY = 'leaderboard:top50:rating';

export const GET: APIRoute = async ({ url }) => {
	const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
	const sort = url.searchParams.get('sort') === 'games' ? 'games' : 'rating';

	// Only cache the default (top 50, sort=rating) request — custom queries bypass cache.
	const isDefaultQuery = limit === 50 && sort === 'rating';
	const cacheKey = isDefaultQuery ? CACHE_KEY : null;

	if (cacheKey && env.KV) {
		const cached = await env.KV.get<LeaderboardEntry[]>(cacheKey, 'json');
		if (cached) {
			return Response.json({ entries: cached, cached: true });
		}
	}

	const entries = await env.MATCHMAKER.getByName('global').getLeaderboard(limit, sort);

	if (cacheKey && env.KV) {
		// Fire-and-forget cache write — don't block the response.
		env.KV.put(cacheKey, JSON.stringify(entries), { expirationTtl: CACHE_TTL }).catch(() => {});
	}

	return Response.json({ entries, cached: false });
};
