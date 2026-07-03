/**
 * `GET /api/lobby` — active games list + aggregate stats for the spectator TV
 * page (`/games`). Reads directly from the `GameLobby` singleton Durable
 * Object; response is never cached (`Cache-Control: no-store`) since the
 * page polls this endpoint every 15s for a "live" feel.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const GET: APIRoute = async () => {
	const lobby = env.GAME_LOBBY.getByName('global');
	const [games, stats] = await Promise.all([
		lobby.listGames(20),
		lobby.getStats(),
	]);
	return Response.json({ games, stats }, {
		headers: { 'Cache-Control': 'no-store' },
	});
};
