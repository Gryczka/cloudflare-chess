/**
 * `GameLobby` — a global-singleton Durable Object (always accessed via
 * `getByName('global')`) that tracks all currently active (non-bot,
 * non-ended) rated matches for the spectator TV feature.
 *
 * `ChessMatch` instances push updates here via RPC as fire-and-forget calls
 * (register on start, update on presence/ply change, deregister on end) —
 * every call site wraps the RPC in `.catch()` so a lobby outage can never
 * block actual gameplay. The landing page ribbon and `/games` spectator page
 * read the authoritative list from this DO via `GET /api/lobby`.
 */

import { DurableObject } from 'cloudflare:workers';
import { log } from '../log';

export type LobbyEntry = {
	matchId: string;
	whiteName: string;
	blackName: string;
	whiteRating: number;
	blackRating: number;
	timeControlMs: number;
	spectators: number;
	startedAt: number;
	ply: number;
};

type LobbyRow = LobbyEntry;

export class GameLobby extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS active_games (
				matchId       TEXT PRIMARY KEY,
				whiteName     TEXT NOT NULL,
				blackName     TEXT NOT NULL,
				whiteRating   INTEGER NOT NULL DEFAULT 1200,
				blackRating   INTEGER NOT NULL DEFAULT 1200,
				timeControlMs INTEGER NOT NULL DEFAULT 300000,
				spectators    INTEGER NOT NULL DEFAULT 0,
				startedAt     INTEGER NOT NULL,
				ply           INTEGER NOT NULL DEFAULT 0
			);
		`);
	}

	/** Register a newly started rated human match. Called by `ChessMatch.init()`. */
	async registerMatch(entry: Omit<LobbyEntry, 'spectators' | 'ply'>): Promise<void> {
		this.ctx.storage.sql.exec(
			`INSERT OR REPLACE INTO active_games (matchId, whiteName, blackName, whiteRating, blackRating, timeControlMs, spectators, startedAt, ply)
			 VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0)`,
			entry.matchId, entry.whiteName, entry.blackName,
			entry.whiteRating, entry.blackRating, entry.timeControlMs,
			entry.startedAt,
		);
		log.info('lobby.registered', { matchId: entry.matchId });
	}

	/** Update a match's live spectator count and ply. Called on every presence change. */
	async updateMatch(matchId: string, spectators: number, ply: number): Promise<void> {
		this.ctx.storage.sql.exec(
			`UPDATE active_games SET spectators = ?, ply = ? WHERE matchId = ?`,
			spectators, ply, matchId,
		);
	}

	/** Remove a match from the active list. Called by `ChessMatch.endGame()`. */
	async deregisterMatch(matchId: string): Promise<void> {
		this.ctx.storage.sql.exec(`DELETE FROM active_games WHERE matchId = ?`, matchId);
		log.info('lobby.deregistered', { matchId });
	}

	/** List active games, most-watched first, for the spectator TV page. */
	async listGames(limit = 20): Promise<LobbyEntry[]> {
		return this.ctx.storage.sql
			.exec<LobbyRow>(
				`SELECT * FROM active_games ORDER BY spectators DESC, startedAt DESC LIMIT ?`,
				Math.min(50, limit),
			)
			.toArray();
	}

	/** Aggregate active-game and total-spectator counts for the landing page ribbon. */
	async getStats(): Promise<{ activeGames: number; totalSpectators: number }> {
		const row = this.ctx.storage.sql
			.exec<{ games: number; spectators: number }>(
				`SELECT COUNT(*) as games, SUM(spectators) as spectators FROM active_games`,
			)
			.toArray()[0];
		return {
			activeGames: row?.games ?? 0,
			totalSpectators: row?.spectators ?? 0,
		};
	}
}
