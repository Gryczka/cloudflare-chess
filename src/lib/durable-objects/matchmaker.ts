import { DurableObject } from 'cloudflare:workers';
import { resolvePlayerId, safeUsername } from '../identity';
import { BOT_CONFIGS, type BotDifficulty } from '../chess/bot';
import { generatePlayerId, generateSecret, isValidPlayerId, isValidSecret } from '../player-id';
import { hashSecret } from '../crypto';
import { log } from '../log';
import * as d1 from '../d1/profiles';
import {
	isTimeControl,
	type LeaderboardEntry,
	type MatchInit,
	type MatchmakerServerMessage,
	type PlayerColor,
	type ProfileBundle,
	type PublicProfile,
	type RatingGameResult,
	type RatingGameUpdate,
	type RatingHistoryEntry,
	type RatingSnapshot,
	type TimeControlMs,
} from '../messages';

type QueueRow = {
	playerId: string;
	username: string;
	timeControlMs: number;
	joinedAt: number;
};

type MatchmakerSession = {
	playerId: string;
	username: string;
	timeControlMs: TimeControlMs;
};

// Bridge: convert D1 snake_case ProfileRow to the camelCase PublicProfile used by the API.
function d1PublicProfile(row: d1.ProfileRow): PublicProfile {
	return {
		playerId: row.player_id,
		username: row.username,
		rating: row.rating,
		peakRating: row.peak_rating,
		games: row.games,
		wins: row.wins,
		losses: row.losses,
		draws: row.draws,
		botGames: row.bot_games,
		botWins: row.bot_wins,
		botLosses: row.bot_losses,
		botDraws: row.bot_draws,
		isProvisional: row.games < 10,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/**
 * `Matchmaker` — a global-singleton Durable Object (always accessed via
 * `getByName('global')`) that coordinates the matchmaking queue and creates
 * new `ChessMatch` instances.
 *
 * This DO owns only hot-path coordination state in its own SQLite storage
 * (`queue`, `pairings`); player profiles, Elo ratings, and rating history
 * live in D1 (see `src/lib/d1/profiles.ts`) so they can be queried globally
 * (leaderboards) rather than being scattered across per-match DOs.
 * Responsibilities:
 * - Account enrollment (`mintPlayerId`) and recovery-secret login
 *   (`loginWithSecret`).
 * - FIFO-ish pairing within a time-control tier (`tryPair`), with a 5-minute
 *   alarm-driven prune for players who queued and disappeared.
 * - Bot match and rematch creation.
 * - Delegating rating updates to the D1 layer (`recordGame`).
 */
export class Matchmaker extends DurableObject<Env> {
	private sessions = new Map<WebSocket, MatchmakerSession>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ensureSchema();

		for (const ws of this.ctx.getWebSockets()) {
			const attachment = ws.deserializeAttachment() as MatchmakerSession | undefined;
			if (attachment?.playerId && isTimeControl(attachment.timeControlMs)) {
				this.sessions.set(ws, attachment);
			}
		}

		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}

	/**
	 * Upgrade an authenticated request to a matchmaking WebSocket. The
	 * connection is enqueued immediately and a pairing attempt runs
	 * synchronously before returning, so a lucky joiner can be paired within
	 * the same request that opened their socket.
	 */
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected WebSocket upgrade', { status: 426 });
		}

		const url = new URL(request.url);
		const time = Number(url.searchParams.get('time'));
		if (!isTimeControl(time)) return new Response('Unsupported time control', { status: 400 });

		const playerId = await resolvePlayerId(request, this.env.AUTH_SECRET);
		if (!playerId) return new Response('Enroll before matchmaking', { status: 401 });

		const username = safeUsername(url.searchParams.get('username'));
		await d1.upsertProfile(this.env.DB, playerId, username);
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		const session: MatchmakerSession = { playerId, username, timeControlMs: time };

		this.ctx.acceptWebSocket(server);
		server.serializeAttachment(session);
		this.sessions.set(server, session);

		this.ctx.storage.sql.exec(`DELETE FROM queue WHERE playerId = ?`, playerId);
		this.ctx.storage.sql.exec(
			`INSERT INTO queue (playerId, username, timeControlMs, joinedAt) VALUES (?, ?, ?, ?)`,
			playerId,
			username,
			time,
			Date.now(),
		);

		await this.tryPair(time);
		await this.schedulePrune();

		return new Response(null, { status: 101, webSocket: client });
	}

	/**
	 * Create a new anonymous account: generates a unique public handle and a
	 * fresh recovery secret, and persists the profile in D1 (only the
	 * secret's hash is stored).
	 *
	 * @param username - Display name chosen by the player (sanitized upstream).
	 * @returns The new handle, the recovery secret (return this to the client
	 *   exactly once — it cannot be recovered later), and the initial profile.
	 * @throws If a unique handle could not be generated after 10 attempts.
	 */
	async mintPlayerId(username: string): Promise<{ playerId: string; secret: string; profile: PublicProfile }> {
		for (let i = 0; i < 10; i++) {
			const playerId = generatePlayerId();
			const existing = await d1.getProfile(this.env.DB, playerId);
			if (!existing) {
				const secret = generateSecret();
				const secretHash = await hashSecret(secret);
				const profile = await d1.createProfile(this.env.DB, playerId, safeUsername(username), secretHash);
				log.info('player.enrolled', { playerId, username: profile.username });
				return { playerId, secret, profile: d1PublicProfile(profile) };
			}
		}
		throw new Error('Failed to generate a unique player ID.');
	}

	/**
	 * Account recovery (QR-1): authenticate by the recovery secret, never by
	 * the public handle (the handle alone proves nothing).
	 *
	 * @param secret - The `cfk_…` recovery secret supplied by the player.
	 * @returns The recovered handle + profile, or `null` if the secret is
	 *   malformed or unknown. Callers should mint a fresh signed session
	 *   cookie for the returned handle.
	 */
	async loginWithSecret(secret: string): Promise<{ playerId: string; profile: PublicProfile } | null> {
		if (!isValidSecret(secret)) return null;
		const secretHash = await hashSecret(secret);
		const profile = await d1.getProfileBySecretHash(this.env.DB, secretHash);
		if (!profile) {
			log.warn('player.login_failed', { reason: 'unknown_secret' });
			return null;
		}
		log.info('player.login', { playerId: profile.player_id });
		return { playerId: profile.player_id, profile: d1PublicProfile(profile) };
	}

	/** Fetch a player's public profile plus their recent rating-history entries. */
	async getProfileBundle(playerId: string, limit = 10): Promise<ProfileBundle | null> {
		if (!isValidPlayerId(playerId)) return null;
		const [profile, recent] = await Promise.all([
			d1.getPublicProfileWithTc(this.env.DB, playerId),
			d1.getRatingHistory(this.env.DB, playerId, limit),
		]);
		if (!profile) return null;
		return { profile, recent };
	}

	/** Fetch the top-rated players for the public leaderboard. */
	async getLeaderboard(limit = 50, _sort: 'rating' | 'games' = 'rating'): Promise<LeaderboardEntry[]> {
		return d1.getLeaderboard(this.env.DB, limit);
	}

	/**
	 * Create a rematch from a completed game: same two participants (or bot),
	 * colors swapped, same time control.
	 *
	 * @param originalMatchId - The finished match to rematch from.
	 * @param requestingPlayerId - The player initiating the rematch (must have
	 *   been a participant in the original match).
	 * @returns The new match id and the requester's (swapped) color, or an
	 *   `{ error }` if the original match is unknown or the requester wasn't
	 *   a participant.
	 */
	async createRematch(originalMatchId: string, requestingPlayerId: string): Promise<{ matchId: string; color: PlayerColor; rating: number } | { error: string }> {
		// Read original pairing
		const pairing = this.ctx.storage.sql
			.exec<{ whiteId: string; blackId: string; matchId: string }>(
				`SELECT matchId, whiteId, blackId FROM pairings WHERE matchId = ?`,
				originalMatchId,
			)
			.toArray()[0];
		if (!pairing) return { error: 'original_match_not_found' };

		const wasWhite = pairing.whiteId === requestingPlayerId;
		const wasBlack = pairing.blackId === requestingPlayerId;
		if (!wasWhite && !wasBlack) return { error: 'not_a_player' };

		// Swap colors for the rematch
		const newWhiteId = wasWhite ? pairing.blackId : pairing.whiteId;
		const newBlackId = wasWhite ? pairing.whiteId : pairing.blackId;
		const newMatchId = crypto.randomUUID();

		const whiteProfile = await this.resolveProfileForPairing(newWhiteId);
		const blackProfile = await this.resolveProfileForPairing(newBlackId);

		// Bot rematch: one side is a bot
		const whiteBotConfig = Object.values(BOT_CONFIGS).find((c) => c.id === newWhiteId);
		const blackBotConfig = Object.values(BOT_CONFIGS).find((c) => c.id === newBlackId);
		const isBot = !!(whiteBotConfig || blackBotConfig);

		// Read time control from the archived pairing's match meta — fall back to 5min
		// (we don't have a stored TC on the pairing row, but 5min is a safe default for now;
		// Phase 3-F's D1 schema will carry this properly).
		const timeControlMs: TimeControlMs = 300000;

		this.ctx.storage.sql.exec(`DELETE FROM queue WHERE playerId IN (?, ?)`, newWhiteId, newBlackId);
		this.ctx.storage.sql.exec(
			`INSERT INTO pairings (matchId, whiteId, blackId, createdAt) VALUES (?, ?, ?, ?)`,
			newMatchId,
			newWhiteId,
			newBlackId,
			Date.now(),
		);

		const init: MatchInit = {
			matchId: newMatchId,
			whiteId: newWhiteId,
			blackId: newBlackId,
			whiteName: whiteBotConfig?.name ?? whiteProfile.username,
			blackName: blackBotConfig?.name ?? blackProfile.username,
			whiteRating: whiteBotConfig?.rating ?? whiteProfile.rating,
			blackRating: blackBotConfig?.rating ?? blackProfile.rating,
			whiteGames: whiteProfile.games,
			blackGames: blackProfile.games,
			mode: isBot ? 'bot' : 'rated',
			timeControlMs,
		};

		await this.env.CHESS_MATCH.getByName(newMatchId).init(init);
		const requestorColor: PlayerColor = wasWhite ? 'black' : 'white'; // swapped
		const requestorProfile = wasWhite ? blackProfile : whiteProfile;
		log.info('game.rematch', { originalMatchId, newMatchId, requestingPlayerId });
		return { matchId: newMatchId, color: requestorColor, rating: requestorProfile.rating };
	}

	/**
	 * Create a new game between a human player (as white) and a bot opponent.
	 *
	 * @param difficulty - Which bot personality to play against; defaults to
	 *   the mid-tier `knight` bot.
	 * @throws If `timeControlMs` is not one of the supported time controls.
	 */
	async createBotMatch(playerId: string, username: string, timeControlMs: TimeControlMs, difficulty: BotDifficulty = 'knight'): Promise<{ matchId: string; color: PlayerColor; rating: number }> {
		if (!isTimeControl(timeControlMs)) throw new Error('Unsupported time control.');
		const humanRow = await d1.upsertProfile(this.env.DB, playerId, safeUsername(username));
		const human = { playerId: humanRow.player_id, username: humanRow.username, rating: humanRow.rating, games: humanRow.games };
		const bot = BOT_CONFIGS[difficulty] ?? BOT_CONFIGS.knight;
		const matchId = crypto.randomUUID();

		this.ctx.storage.sql.exec(`DELETE FROM queue WHERE playerId = ?`, playerId);
		this.ctx.storage.sql.exec(
			`INSERT INTO pairings (matchId, whiteId, blackId, createdAt) VALUES (?, ?, ?, ?)`,
			matchId,
			playerId,
			bot.id,
			Date.now(),
		);

		const init: MatchInit = {
			matchId,
			whiteId: playerId,
			blackId: bot.id,
			whiteName: human.username,
			blackName: bot.name,
			whiteRating: human.rating,
			blackRating: bot.rating,
			whiteGames: human.games,
			blackGames: 0,
			mode: 'bot',
			timeControlMs,
		};

		await this.env.CHESS_MATCH.getByName(matchId).init(init);
		this.broadcastWaiting(timeControlMs);
		return { matchId, color: 'white', rating: human.rating };
	}

	// Helper used by createRematch below.
	private async resolveProfileForPairing(playerId: string): Promise<{ playerId: string; username: string; rating: number; games: number }> {
		const botCfg = Object.values(BOT_CONFIGS).find((c) => c.id === playerId);
		if (botCfg) return { playerId, username: botCfg.name, rating: botCfg.rating, games: 0 };
		const row = await d1.upsertProfile(this.env.DB, playerId, playerId);
		return { playerId: row.player_id, username: row.username, rating: row.rating, games: row.games };
	}

	/**
	 * Record a completed game's result and update ratings. Thin RPC wrapper
	 * around the D1 layer (`d1.recordGame`, idempotency handled there) so
	 * `ChessMatch` never touches D1 directly. Also invalidates the KV
	 * leaderboard cache on any rating change.
	 */
	async recordGame(result: RatingGameResult): Promise<RatingGameUpdate> {
		// Delegate entirely to the D1 layer (QR-5 idempotency handled there).
		const update = await d1.recordGame(this.env.DB, result);
		log.info('game.ratings_recorded', {
			matchId: result.matchId, result: result.result,
			whiteId: result.whiteId, blackId: result.blackId,
		});
		// P4-B: invalidate KV leaderboard cache after any rating change.
		this.env.KV?.delete('leaderboard:top50:rating').catch(() => {});
		return update;
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const session = this.sessions.get(ws);
		if (!session) return;

		let parsed: { type?: string };
		try {
			parsed = JSON.parse(String(message));
		} catch {
			this.send(ws, { type: 'error', code: 'bad_json', message: 'Invalid JSON.' });
			return;
		}

		if (parsed.type === 'cancel') {
			this.ctx.storage.sql.exec(`DELETE FROM queue WHERE playerId = ?`, session.playerId);
			this.sessions.delete(ws);
			ws.close(1000, 'cancelled');
			this.broadcastWaiting(session.timeControlMs);
		}
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		const session = this.sessions.get(ws);
		if (!session) return;
		this.sessions.delete(ws);
		this.ctx.storage.sql.exec(`DELETE FROM queue WHERE playerId = ?`, session.playerId);
		this.broadcastWaiting(session.timeControlMs);
	}

	async alarm(): Promise<void> {
		const cutoff = Date.now() - 5 * 60 * 1000;
		this.ctx.storage.sql.exec(`DELETE FROM queue WHERE joinedAt < ?`, cutoff);
		await this.schedulePrune();
	}

	private ensureSchema(): void {
		// P3-E: Matchmaker DO now owns only coordination tables (queue + pairings).
		// Profile, rating_history, and rated_games live in D1 (cf-chess-profiles DB).
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS queue (
				playerId TEXT PRIMARY KEY,
				username TEXT NOT NULL,
				timeControlMs INTEGER NOT NULL,
				joinedAt INTEGER NOT NULL
			);
		`);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS pairings (
				matchId TEXT PRIMARY KEY,
				whiteId TEXT NOT NULL,
				blackId TEXT NOT NULL,
				createdAt INTEGER NOT NULL
			);
		`);
		this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS queue_by_tier ON queue(timeControlMs, joinedAt);`);
	}

	private async tryPair(timeControlMs: TimeControlMs): Promise<void> {
		while (true) {
			const rows = this.ctx.storage.sql
				.exec<QueueRow>(
					`SELECT playerId, username, timeControlMs, joinedAt FROM queue WHERE timeControlMs = ? ORDER BY joinedAt ASC LIMIT 6`,
					timeControlMs,
				)
				.toArray()
				.filter((row) => this.socketFor(row.playerId));

			if (rows.length < 2) {
				this.broadcastWaiting(timeControlMs);
				return;
			}

			const [first, second] = rows;
			const firstIsWhite = crypto.getRandomValues(new Uint8Array(1))[0] % 2 === 0;
			const white = firstIsWhite ? first : second;
			const black = firstIsWhite ? second : first;
			const matchId = crypto.randomUUID();

		// Dequeue both players and record the pairing in DO SQLite (QR-10 atomicity
		// for the coordination tables). Profile upserts go to D1 (async, outside the
		// sync transaction — D1 does not support synchronous transactions).
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec(`DELETE FROM queue WHERE playerId IN (?, ?)`, first.playerId, second.playerId);
			this.ctx.storage.sql.exec(
				`INSERT INTO pairings (matchId, whiteId, blackId, createdAt) VALUES (?, ?, ?, ?)`,
				matchId,
				white.playerId,
				black.playerId,
				Date.now(),
			);
		});
		const [whiteProfile, blackProfile] = await Promise.all([
			d1.upsertProfile(this.env.DB, white.playerId, white.username),
			d1.upsertProfile(this.env.DB, black.playerId, black.username),
		]);

		const init: MatchInit = {
			matchId,
			whiteId: white.playerId,
			blackId: black.playerId,
			whiteName: white.username,
			blackName: black.username,
			whiteRating: whiteProfile.rating,
			blackRating: blackProfile.rating,
			whiteGames: whiteProfile.games,
			blackGames: blackProfile.games,
			mode: 'rated',
			timeControlMs,
		};
		// NOTE: whiteProfile/blackProfile are now d1.ProfileRow; .rating/.games accessed directly.

			await this.env.CHESS_MATCH.getByName(matchId).init(init);
			this.finishPair(white.playerId, matchId, 'white');
			this.finishPair(black.playerId, matchId, 'black');
		}
	}

	private finishPair(playerId: string, matchId: string, color: PlayerColor): void {
		const ws = this.socketFor(playerId);
		if (!ws) return;
		this.send(ws, { type: 'matched', matchId, color });
		this.sessions.delete(ws);
		ws.close(1000, 'matched');
	}

	private socketFor(playerId: string): WebSocket | undefined {
		for (const [ws, session] of this.sessions) {
			if (session.playerId === playerId) return ws;
		}
		return undefined;
	}

	private broadcastWaiting(timeControlMs: TimeControlMs): void {
		const count = this.ctx.storage.sql
			.exec<{ count: number }>(`SELECT COUNT(*) as count FROM queue WHERE timeControlMs = ?`, timeControlMs)
			.one().count;

		for (const [ws, session] of this.sessions) {
			if (session.timeControlMs === timeControlMs) this.send(ws, { type: 'waiting', queueSize: count, timeControlMs });
		}
	}

	private async schedulePrune(): Promise<void> {
		const row = this.ctx.storage.sql.exec<{ joinedAt: number }>(`SELECT joinedAt FROM queue ORDER BY joinedAt ASC LIMIT 1`).toArray()[0];
		if (!row) return;
		await this.ctx.storage.setAlarm(row.joinedAt + 5 * 60 * 1000);
	}

	private send(ws: WebSocket, message: MatchmakerServerMessage): void {
		try {
			ws.send(JSON.stringify(message));
		} catch {
			this.sessions.delete(ws);
		}
	}

}
