/**
 * `GET /api/stats` — live platform stats for the landing page hero ribbon:
 * active game count and total spectators (from the `GameLobby` DO), plus
 * total registered players (from D1). Each data source is read defensively
 * (try/catch) so a cold-start or missing table degrades to `0` rather than
 * failing the whole response — useful right after a fresh deploy before any
 * games have been played.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const GET: APIRoute = async () => {
	let activeGames = 0;
	let totalSpectators = 0;
	let totalPlayers = 0;

	// Read live game stats from GameLobby singleton.
	try {
		const lobbyId = env.GAME_LOBBY.idFromName('global');
		const lobby = env.GAME_LOBBY.get(lobbyId);
		const s = await lobby.getStats();
		activeGames = s.activeGames;
		totalSpectators = s.totalSpectators;
	} catch { /* lobby may not be initialised yet */ }

	// Count registered players from D1.
	try {
		const row = await env.DB.prepare('SELECT COUNT(*) as n FROM profiles').first<{ n: number }>();
		totalPlayers = row?.n ?? 0;
	} catch { /* DB may not have profiles table yet */ }

	return Response.json(
		{ activeGames, totalSpectators, totalPlayers },
		{ headers: { 'Cache-Control': 'public, s-maxage=15, max-age=10' } },
	);
};
