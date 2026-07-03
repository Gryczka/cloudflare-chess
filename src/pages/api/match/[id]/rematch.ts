// P3-D: POST /api/match/:id/rematch — create a rematch with swapped colors.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { resolvePlayerId } from '../../../../lib/identity';

export const prerender = false;

export const POST: APIRoute = async ({ params, request }) => {
	const matchId = params.id ?? '';
	if (!matchId) return new Response('Missing match ID', { status: 400 });

	const playerId = await resolvePlayerId(request, env.AUTH_SECRET);
	if (!playerId) return new Response('Unauthorized', { status: 401 });

	const result = await env.MATCHMAKER.getByName('global').createRematch(matchId, playerId);
	if ('error' in result) return Response.json({ error: result.error }, { status: 400 });

	return Response.json(result);
};
