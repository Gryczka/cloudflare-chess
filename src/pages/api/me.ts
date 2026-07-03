import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { resolvePlayerId } from '../../lib/identity';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
	const playerId = await resolvePlayerId(request, env.AUTH_SECRET);
	if (!playerId) return new Response('Not enrolled', { status: 404 });
	const bundle = await env.MATCHMAKER.getByName('global').getProfileBundle(playerId, 10);
	if (!bundle) return new Response('Not enrolled', { status: 404 });
	return Response.json(bundle);
};
