// P4-E: GET /api/match/:id/analysis — returns AI coaching analysis from R2.
// Returns 202 Accepted if analysis is not yet ready (still queued/processing).
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
	const matchId = params.id ?? '';
	if (!matchId) return new Response('Missing match ID', { status: 400 });

	if (!env.R2_ARCHIVE) return new Response('Archive not configured', { status: 503 });

	const obj = await env.R2_ARCHIVE.get(`analysis/${matchId}.json`);
	if (!obj) {
		return new Response(JSON.stringify({ status: 'pending' }), {
			status: 202,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	return new Response(obj.body, {
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'public, max-age=3600',
		},
	});
};
