/**
 * Chess rules engine wrapper around `chess.js`. This is the single source of
 * move legality and game-end detection used by `ChessMatch` (human moves) and
 * the bot search (`bot-search.ts`) alike, so both paths share one rules
 * implementation.
 */
import { Chess } from 'chess.js';
import type { EngineEndState, ValidatedMove } from './types';

/** The standard chess starting position, as a FEN string. */
export const START_FEN = new Chess().fen();

/**
 * Validate and apply a single move against a position.
 *
 * @param fen - The current position (used when `history` is absent).
 * @param from - Source square, e.g. `"e2"`.
 * @param to - Destination square, e.g. `"e4"`.
 * @param promotion - Promotion piece, if the move is a pawn promotion.
 * @param history - Full UCI move list from the start position. When
 *   supplied, the position is rebuilt by replaying this history instead of
 *   loading the bare FEN, which preserves position history — required for
 *   `isThreefoldRepetition()` to work correctly.
 * @returns The resulting move (SAN, UCI, new FEN, whose turn, and end state),
 *   or `null` if the move is illegal.
 */
export function validateMove(
	fen: string,
	from: string,
	to: string,
	promotion?: 'q' | 'r' | 'b' | 'n',
	history?: string[],
): ValidatedMove | null {
	// When the full move history (UCI, from the start position) is supplied we
	// replay it so chess.js retains position history — required for threefold /
	// fivefold repetition detection. A bare FEN has no history, so
	// isThreefoldRepetition() can never fire (QR-4). Falls back to the FEN if
	// the history is missing or fails to replay.
	const chess = buildChess(fen, history);
	let move;
	try {
		move = chess.move(promotion ? { from, to, promotion } : { from, to });
	} catch {
		return null;
	}
	if (!move) return null;

	return {
		san: move.san,
		uci: `${move.from}${move.to}${move.promotion ?? ''}`,
		fen: chess.fen(),
		turn: chess.turn(),
		endState: getEndState(chess),
	};
}

/**
 * Inspect a `chess.js` instance for a terminal game state.
 *
 * @param chess - A chess.js instance positioned after the move to check.
 * @returns `{ ended: false }` if the game continues, otherwise the result
 *   (`1-0` / `0-1` / `1/2-1/2`) and a human-readable reason.
 */
export function getEndState(chess: Chess): EngineEndState {
	if (chess.isCheckmate()) {
		return {
			ended: true,
			result: chess.turn() === 'w' ? '0-1' : '1-0',
			reason: 'checkmate',
		};
	}

	if (chess.isStalemate()) return { ended: true, result: '1/2-1/2', reason: 'stalemate' };
	if (chess.isThreefoldRepetition()) return { ended: true, result: '1/2-1/2', reason: 'threefold repetition' };
	if (chess.isInsufficientMaterial()) return { ended: true, result: '1/2-1/2', reason: 'insufficient material' };
	if (chess.isDraw()) return { ended: true, result: '1/2-1/2', reason: 'draw' };

	return { ended: false };
}

/** Convert chess.js's single-letter turn code to a full color name. */
export function turnName(turn: 'w' | 'b'): 'white' | 'black' {
	return turn === 'w' ? 'white' : 'black';
}

// Build a Chess instance. With history (UCI moves from the start position) we
// replay so repetition tracking works; otherwise we load the bare FEN.
function buildChess(fen: string, history?: string[]): Chess {
	if (history && history.length > 0) {
		const chess = new Chess();
		try {
			for (const uci of history) chess.move(uciToMove(uci));
			return chess;
		} catch {
			// Corrupt/inconsistent history — fall back to the authoritative FEN.
		}
	}
	return new Chess(fen);
}

function uciToMove(uci: string): { from: string; to: string; promotion?: string } {
	const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;
	return { from: uci.slice(0, 2), to: uci.slice(2, 4), ...(promotion ? { promotion } : {}) };
}
