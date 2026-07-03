/**
 * D1 data-access layer for player profiles, Elo ratings, rating history, and
 * rated-game records.
 *
 * All profile/rating persistence lives here rather than in Durable Object
 * SQLite, because profile data needs to be queried across all players
 * (leaderboards, lookups) — a shape D1's shared relational database serves
 * better than DO storage, which is naturally partitioned per-object. The
 * `Matchmaker` Durable Object retains only its hot-path coordination tables
 * (matchmaking queue + active pairings) and delegates all profile/rating
 * reads and writes to the functions in this module.
 */

import type {
	GameResult,
	LeaderboardEntry,
	PlayerColor,
	PublicProfile,
	RatingGameResult,
	RatingGameUpdate,
	RatingHistoryEntry,
	RatingSnapshot,
} from '../messages';
import { BOT_CONFIGS } from '../chess/bot';

// ── Row types matching the D1 schema ────────────────────────────────────────

export type ProfileRow = {
	player_id: string;
	username: string;
	secret_hash: string | null;
	rating: number;
	peak_rating: number;
	games: number;
	wins: number;
	losses: number;
	draws: number;
	bot_games: number;
	bot_wins: number;
	bot_losses: number;
	bot_draws: number;
	created_at: number;
	updated_at: number;
};

type RatedGameRow = {
	match_id: string;
	white_id: string;
	black_id: string;
	white_delta: number;
	black_delta: number;
	time_control: string;
};

type HistoryRow = {
	id: number;
	player_id: string;
	match_id: string;
	time_control: string;
	rating: number;
	delta: number;
	opponent_id: string;
	result: GameResult;
	is_bot: number;
	timestamp: number;
};

const STARTING_RATING = 1200;

// ── Helpers ─────────────────────────────────────────────────────────────────

function toPublicProfile(row: ProfileRow): PublicProfile {
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

function toSnapshot(row: ProfileRow, delta: number): RatingSnapshot {
	return { ...toPublicProfile(row), delta };
}

function botProfileRow(playerId: string, username: string): ProfileRow {
	const bot = Object.values(BOT_CONFIGS).find((c) => c.id === playerId);
	const rating = bot?.rating ?? 1200;
	const now = Date.now();
	return {
		player_id: playerId,
		username: bot?.name ?? username,
		secret_hash: null,
		rating,
		peak_rating: rating,
		games: 0,
		wins: 0,
		losses: 0,
		draws: 0,
		bot_games: 0,
		bot_wins: 0,
		bot_losses: 0,
		bot_draws: 0,
		created_at: now,
		updated_at: now,
	};
}

function eloDeltas(white: ProfileRow, black: ProfileRow, result: GameResult): { whiteDelta: number; blackDelta: number } {
	const expectedWhite = 1 / (1 + 10 ** ((black.rating - white.rating) / 400));
	const scoreWhite = result === '1-0' ? 1 : result === '0-1' ? 0 : 0.5;
	const k = (g: number) => g < 30 ? 40 : 20;
	return {
		whiteDelta: Math.round(k(white.games) * (scoreWhite - expectedWhite)),
		blackDelta: Math.round(k(black.games) * ((1 - scoreWhite) - (1 - expectedWhite))),
	};
}

function outcomeFor(result: GameResult, color: PlayerColor): 'win' | 'loss' | 'draw' {
	if (result === '1/2-1/2') return 'draw';
	if (color === 'white') return result === '1-0' ? 'win' : 'loss';
	return result === '0-1' ? 'win' : 'loss';
}

function timeControlLabel(ms: number): string {
	if (ms <= 60000) return 'bullet';
	if (ms <= 300000) return 'blitz';
	return 'rapid';
}

// ── Read operations ──────────────────────────────────────────────────────────

/** Fetch a raw profile row by player id, or `null` if the player doesn't exist. */
export async function getProfile(db: D1Database, playerId: string): Promise<ProfileRow | null> {
	const result = await db.prepare(`SELECT * FROM profiles WHERE player_id = ?`).bind(playerId).first<ProfileRow>();
	return result ?? null;
}

/**
 * Fetch a player's public profile along with their per-time-control ratings
 * (bullet/blitz/rapid), joined from the `tc_ratings` table.
 *
 * @returns A `PublicProfile` with `bulletRating`/`blitzRating`/`rapidRating`
 *   populated where available, or `null` if the player doesn't exist.
 */
export async function getPublicProfileWithTc(db: D1Database, playerId: string): Promise<import('../messages').PublicProfile | null> {
	const [profile, tcRows] = await Promise.all([
		getProfile(db, playerId),
		db.prepare(`SELECT time_control, rating FROM tc_ratings WHERE player_id = ?`).bind(playerId).all<{ time_control: string; rating: number }>(),
	]);
	if (!profile) return null;
	const base = toPublicProfile(profile);
	const tcMap: Record<string, number> = {};
	for (const row of tcRows.results) tcMap[row.time_control] = row.rating;
	return {
		...base,
		bulletRating: tcMap['bullet'],
		blitzRating: tcMap['blitz'],
		rapidRating: tcMap['rapid'],
	};
}

export async function getProfileBySecretHash(db: D1Database, secretHash: string): Promise<ProfileRow | null> {
	const result = await db.prepare(`SELECT * FROM profiles WHERE secret_hash = ?`).bind(secretHash).first<ProfileRow>();
	return result ?? null;
}

export async function getPublicProfile(db: D1Database, playerId: string): Promise<PublicProfile | null> {
	const row = await getProfile(db, playerId);
	return row ? toPublicProfile(row) : null;
}

/** Fetch a player's most recent rating-change events, newest first. */
export async function getRatingHistory(db: D1Database, playerId: string, limit: number): Promise<RatingHistoryEntry[]> {
	const { results } = await db
		.prepare(`SELECT * FROM rating_history WHERE player_id = ? ORDER BY timestamp DESC LIMIT ?`)
		.bind(playerId, Math.max(1, Math.min(100, limit)))
		.all<HistoryRow>();
	return results.map((row) => ({
		id: row.id,
		playerId: row.player_id,
		matchId: row.match_id,
		rating: row.rating,
		delta: row.delta,
		opponentId: row.opponent_id,
		result: row.result,
		isBot: Boolean(row.is_bot),
		timestamp: row.timestamp,
	}));
}

/**
 * Fetch the top-rated players (minimum 10 games, to exclude provisional
 * ratings) ordered by rating descending.
 */
export async function getLeaderboard(db: D1Database, limit = 50): Promise<LeaderboardEntry[]> {
	const { results } = await db
		.prepare(`SELECT * FROM profiles WHERE games >= 10 ORDER BY rating DESC, games DESC LIMIT ?`)
		.bind(Math.min(100, limit))
		.all<ProfileRow>();
	return results.map((row, i) => ({
		...toPublicProfile(row),
		rank: i + 1,
		winRate: row.games ? Math.round((row.wins / row.games) * 100) : 0,
	}));
}

// ── Write operations ─────────────────────────────────────────────────────────

/**
 * Create a new profile row starting at 1200 Elo.
 *
 * @param secretHash - SHA-256 hash of the recovery secret, or `null` for
 *   profiles created implicitly (e.g. by matchmaking before enrollment).
 */
export async function createProfile(db: D1Database, playerId: string, username: string, secretHash: string | null): Promise<ProfileRow> {
	const now = Date.now();
	await db.prepare(
		`INSERT INTO profiles (player_id, username, secret_hash, rating, peak_rating, games, wins, losses, draws, bot_games, bot_wins, bot_losses, bot_draws, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?)`,
	).bind(playerId, username, secretHash, STARTING_RATING, STARTING_RATING, now, now).run();
	return (await getProfile(db, playerId))!;
}

/**
 * Fetch a profile, creating it with default (1200 Elo, no secret) values if
 * it doesn't exist yet. Also refreshes the display name on existing profiles.
 */
export async function upsertProfile(db: D1Database, playerId: string, username: string): Promise<ProfileRow> {
	const existing = await getProfile(db, playerId);
	if (!existing) return createProfile(db, playerId, username, null);
	await db.prepare(`UPDATE profiles SET username = ?, updated_at = ? WHERE player_id = ?`)
		.bind(username, Date.now(), playerId).run();
	return (await getProfile(db, playerId))!;
}

// ── recordGame ────────────────────────────────────────────────────────────

/**
 * Record a completed game's result and update both players' ratings.
 *
 * Idempotent (QR-5): keyed by `matchId` in the `rated_games` table, so
 * retrying this call after a partial failure (e.g. the calling Durable
 * Object's alarm retry) never double-applies an Elo delta. Bot games update
 * only the human player's bot win/loss/draw counters (Elo-neutral); games
 * between two humans compute standard Elo deltas and also upsert the
 * relevant per-time-control rating row.
 *
 * @param result - Match id, player ids/names, game result, and time control.
 * @returns The post-game rating snapshot for both sides.
 */
export async function recordGame(db: D1Database, result: RatingGameResult): Promise<RatingGameUpdate> {
	const tc = timeControlLabel(result.timeControlMs ?? 300000);

	// Idempotency: never apply the same match's result twice.
	const prior = await db.prepare(`SELECT * FROM rated_games WHERE match_id = ?`).bind(result.matchId).first<RatedGameRow>();
	if (prior) {
		const white = await getProfile(db, prior.white_id) ?? botProfileRow(prior.white_id, 'Bot');
		const black = await getProfile(db, prior.black_id) ?? botProfileRow(prior.black_id, 'Bot');
		return { white: toSnapshot(white, prior.white_delta), black: toSnapshot(black, prior.black_delta) };
	}

	const whiteIsBot = result.whiteId.startsWith('bot:');
	const blackIsBot = result.blackId.startsWith('bot:');

	const whiteRow = whiteIsBot
		? botProfileRow(result.whiteId, result.whiteName)
		: (await upsertProfile(db, result.whiteId, result.whiteName));
	const blackRow = blackIsBot
		? botProfileRow(result.blackId, result.blackName)
		: (await upsertProfile(db, result.blackId, result.blackName));

	// Bot game: update bot stats on the human profile only.
	if (whiteIsBot || blackIsBot) {
		const human = whiteIsBot ? blackRow : whiteRow;
		const humanColor: PlayerColor = whiteIsBot ? 'black' : 'white';
		const outcome = outcomeFor(result.result, humanColor);
		if (!human.player_id.startsWith('bot:')) {
			await db.batch([
				db.prepare(
					`UPDATE profiles SET bot_games = bot_games + 1, bot_wins = bot_wins + ?, bot_losses = bot_losses + ?, bot_draws = bot_draws + ?, updated_at = ? WHERE player_id = ?`,
				).bind(outcome === 'win' ? 1 : 0, outcome === 'loss' ? 1 : 0, outcome === 'draw' ? 1 : 0, Date.now(), human.player_id),
				db.prepare(
					`INSERT INTO rating_history (player_id, match_id, time_control, rating, delta, opponent_id, result, is_bot, timestamp) VALUES (?, ?, ?, ?, 0, ?, ?, 1, ?)`,
				).bind(human.player_id, result.matchId, tc, human.rating, whiteIsBot ? result.whiteId : result.blackId, result.result, Date.now()),
				db.prepare(
					`INSERT INTO rated_games (match_id, white_id, black_id, white_delta, black_delta, time_control, recorded_at) VALUES (?, ?, ?, 0, 0, ?, ?)`,
				).bind(result.matchId, result.whiteId, result.blackId, tc, Date.now()),
			]);
		}
		const updatedHuman = await getProfile(db, human.player_id) ?? human;
		const finalWhite = whiteIsBot ? whiteRow : updatedHuman;
		const finalBlack = blackIsBot ? blackRow : updatedHuman;
		return { white: toSnapshot(finalWhite, 0), black: toSnapshot(finalBlack, 0) };
	}

	// Rated game: compute Elo deltas and apply atomically via D1 batch.
	const { whiteDelta, blackDelta } = eloDeltas(whiteRow, blackRow, result.result);
	const whiteNewRating = Math.max(100, whiteRow.rating + whiteDelta);
	const blackNewRating = Math.max(100, blackRow.rating + blackDelta);
	const whiteOutcome = outcomeFor(result.result, 'white');
	const blackOutcome = outcomeFor(result.result, 'black');
	const now = Date.now();

	await db.batch([
		db.prepare(
			`UPDATE profiles SET rating = ?, peak_rating = MAX(peak_rating, ?), games = games + 1, wins = wins + ?, losses = losses + ?, draws = draws + ?, updated_at = ? WHERE player_id = ?`,
		).bind(whiteNewRating, whiteNewRating, whiteOutcome === 'win' ? 1 : 0, whiteOutcome === 'loss' ? 1 : 0, whiteOutcome === 'draw' ? 1 : 0, now, result.whiteId),
		db.prepare(
			`UPDATE profiles SET rating = ?, peak_rating = MAX(peak_rating, ?), games = games + 1, wins = wins + ?, losses = losses + ?, draws = draws + ?, updated_at = ? WHERE player_id = ?`,
		).bind(blackNewRating, blackNewRating, blackOutcome === 'win' ? 1 : 0, blackOutcome === 'loss' ? 1 : 0, blackOutcome === 'draw' ? 1 : 0, now, result.blackId),
		// P3-F: upsert per-TC ratings
		db.prepare(
			`INSERT INTO tc_ratings (player_id, time_control, rating, peak_rating, games, wins, losses, draws, updated_at)
			 VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
			 ON CONFLICT(player_id, time_control) DO UPDATE SET
			   rating = excluded.rating,
			   peak_rating = MAX(tc_ratings.peak_rating, excluded.rating),
			   games = tc_ratings.games + 1,
			   wins = tc_ratings.wins + excluded.wins,
			   losses = tc_ratings.losses + excluded.losses,
			   draws = tc_ratings.draws + excluded.draws,
			   updated_at = excluded.updated_at`,
		).bind(result.whiteId, tc, whiteNewRating, whiteNewRating, whiteOutcome === 'win' ? 1 : 0, whiteOutcome === 'loss' ? 1 : 0, whiteOutcome === 'draw' ? 1 : 0, now),
		db.prepare(
			`INSERT INTO tc_ratings (player_id, time_control, rating, peak_rating, games, wins, losses, draws, updated_at)
			 VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
			 ON CONFLICT(player_id, time_control) DO UPDATE SET
			   rating = excluded.rating,
			   peak_rating = MAX(tc_ratings.peak_rating, excluded.rating),
			   games = tc_ratings.games + 1,
			   wins = tc_ratings.wins + excluded.wins,
			   losses = tc_ratings.losses + excluded.losses,
			   draws = tc_ratings.draws + excluded.draws,
			   updated_at = excluded.updated_at`,
		).bind(result.blackId, tc, blackNewRating, blackNewRating, blackOutcome === 'win' ? 1 : 0, blackOutcome === 'loss' ? 1 : 0, blackOutcome === 'draw' ? 1 : 0, now),
		db.prepare(
			`INSERT INTO rating_history (player_id, match_id, time_control, rating, delta, opponent_id, result, is_bot, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
		).bind(result.whiteId, result.matchId, tc, whiteNewRating, whiteDelta, result.blackId, result.result, now),
		db.prepare(
			`INSERT INTO rating_history (player_id, match_id, time_control, rating, delta, opponent_id, result, is_bot, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
		).bind(result.blackId, result.matchId, tc, blackNewRating, blackDelta, result.whiteId, result.result, now),
		db.prepare(
			`INSERT INTO rated_games (match_id, white_id, black_id, white_delta, black_delta, time_control, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).bind(result.matchId, result.whiteId, result.blackId, whiteDelta, blackDelta, tc, now),
	]);

	const updatedWhite = (await getProfile(db, result.whiteId))!;
	const updatedBlack = (await getProfile(db, result.blackId))!;
	return { white: toSnapshot(updatedWhite, whiteDelta), black: toSnapshot(updatedBlack, blackDelta) };
}
