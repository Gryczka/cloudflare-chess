import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const GET: APIRoute = async ({ params, url }) => {
	if (!params.id) return new Response('Missing player ID', { status: 400 });
	const limit = Number(url.searchParams.get('limit') ?? 10);
	const bundle = await env.MATCHMAKER.getByName('global').getProfileBundle(params.id, limit);
	if (!bundle) return new Response('Player not found', { status: 404 });
	return Response.json(bundle);
};
