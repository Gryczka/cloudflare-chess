/**
 * Opening explorer — D1 position indexing and query functions.
 *
 * Positions are keyed by a normalized FEN (piece layout + side to move only,
 * stripping castling rights, en-passant target, and move counters) so
 * transpositions that reach the same position are merged into one row. Each
 * `(fen_key, continuation)` pair accumulates a running count and
 * win/draw/loss tally, letting the explorer show "N games played this move,
 * X% white win rate" for any position reachable from recorded games.
 */

import type { GameResult } from '../messages';

export type PositionContinuation = {
	continuation: string; // UCI move, e.g. "e2e4"
	count: number;
	whiteWins: number;
	draws: number;
	blackWins: number;
	winPct: number; // from white's perspective
};

type PositionRow = {
	fen_key: string;
	continuation: string;
	count: number;
	white_wins: number;
	draws: number;
	black_wins: number;
};

/**
 * Normalize a FEN to just the piece placement + side-to-move fields, dropping
 * castling rights, en-passant target, and move clocks. This merges
 * transpositions (different move orders reaching the identical position)
 * into a single explorer entry.
 */
export function normalizeFen(fen: string): string {
	const parts = fen.trim().split(/\s+/);
	// Keep piece placement + active color (first 2 fields only)
	return `${parts[0]} ${parts[1] ?? 'w'}`;
}

/**
 * Query the most-played continuations from a given position, ordered by
 * frequency descending.
 *
 * @param fen - The position to look up (normalized internally).
 * @param limit - Max continuations to return (capped at 20).
 * @returns Each continuation's UCI move, play count, and win/draw/loss tally.
 */
export async function getContinuations(db: D1Database, fen: string, limit = 10): Promise<PositionContinuation[]> {
	const key = normalizeFen(fen);
	const { results } = await db.prepare(
		`SELECT continuation, count, white_wins, draws, black_wins
		 FROM positions WHERE fen_key = ? ORDER BY count DESC LIMIT ?`,
	).bind(key, Math.min(20, limit)).all<PositionRow>();
	return results.map((row) => ({
		continuation: row.continuation,
		count: row.count,
		whiteWins: row.white_wins,
		draws: row.draws,
		blackWins: row.black_wins,
		winPct: row.count > 0 ? Math.round((row.white_wins / row.count) * 100) : 0,
	}));
}

/**
 * Index every position from a completed game into the opening explorer.
 *
 * Called from the Queue consumer (`src/worker.ts`) after a rated game is
 * archived to R2. For each ply, upserts a `(position-before-the-move, move)`
 * row with an incremented count and result tally. Statements are batched in
 * groups of 50 to stay within D1's per-batch limits.
 *
 * @param moves - The game's move list (FEN before each move, plus UCI).
 * @param result - The game's final result, used to tally win/draw/loss.
 */
export async function indexGame(
	db: D1Database,
	moves: Array<{ fen: string; uci: string }>,
	result: GameResult,
): Promise<void> {
	if (!moves.length) return;

	const ww = result === '1-0' ? 1 : 0;
	const bw = result === '0-1' ? 1 : 0;
	const draw = result === '1/2-1/2' ? 1 : 0;

	// Build upsert statements for each position in the game.
	// We index the position BEFORE each move (i.e. from the starting FEN of that ply).
	// For the first move, the starting position is the standard start FEN.
	const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
	const statements: D1PreparedStatement[] = [];

	for (let i = 0; i < moves.length; i++) {
		const prevFen = i === 0 ? START_FEN : moves[i - 1].fen;
		const fenKey = normalizeFen(prevFen);
		const uci = moves[i].uci;

		statements.push(
			db.prepare(
				`INSERT INTO positions (fen_key, continuation, count, white_wins, draws, black_wins)
				 VALUES (?, ?, 1, ?, ?, ?)
				 ON CONFLICT(fen_key, continuation) DO UPDATE SET
				   count = positions.count + 1,
				   white_wins = positions.white_wins + excluded.white_wins,
				   draws = positions.draws + excluded.draws,
				   black_wins = positions.black_wins + excluded.black_wins`,
			).bind(fenKey, uci, ww, draw, bw),
		);

		// Batch in groups of 50 to stay within D1 batch limits.
		if (statements.length >= 50) {
			await db.batch(statements.splice(0, 50));
		}
	}

	if (statements.length > 0) {
		await db.batch(statements);
	}
}
