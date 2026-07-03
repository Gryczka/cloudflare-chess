import { Chess } from 'chess.js';
import { endgameScore } from './bot-endgame';
import { positionKey } from './bot-position-key';
import type { BotConfig, BotMove } from './bot';

const MATE = 100_000;
const INF = 1_000_000;
const PIECE_VALUE: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

type SearchState = {
	config: BotConfig;
	deadline: number;
	timeout: boolean;
	tt: Map<string, { depth: number; score: number; flag: 'exact' | 'lower' | 'upper'; best?: string }>;
	nodes: number;
};

export type SearchResult = BotMove & { scoreCp: number };

// P4-A: search with score — returns the best move AND the centipawn score from
// the perspective of white (positive = white advantage, negative = black advantage).
export function searchWithScore(fen: string, config: BotConfig, remainingMs?: number): SearchResult | null {
	const chess = new Chess(fen);
	const legal = chess.moves({ verbose: true });
	if (!legal.length) return null;

	const budget = Math.max(12, Math.min(config.timeBudgetMs, remainingMs ? Math.floor(remainingMs / 30) : config.timeBudgetMs));
	const state: SearchState = { config, deadline: Date.now() + budget, timeout: false, tt: new Map(), nodes: 0 };
	let best = legal[0];
	let bestScore = 0;
	let scoredRoot = legal.map((move) => ({ move, score: 0 }));

	for (let depth = 1; depth <= config.maxDepth; depth++) {
		let alpha = -INF;
		let beta = INF;
		const iteration: typeof scoredRoot = [];
		const ordered = orderMoves(chess, legal, state, undefined);

		for (const move of ordered) {
			if (isTimedOut(state)) break;
			play(chess, move);
			const score = -negamax(chess, depth - 1, -beta, -alpha, 1, state);
			chess.undo();
			iteration.push({ move, score });
			if (state.timeout) break;
			if (score > alpha) {
				alpha = score;
				best = move;
				bestScore = score;
			}
		}

		if (!state.timeout && iteration.length) {
			iteration.sort((a, b) => b.score - a.score);
			scoredRoot = iteration;
			best = iteration[0].move;
			bestScore = iteration[0].score;
		} else {
			break;
		}
	}

	if (config.blunderRate > 0 && Math.random() < config.blunderRate) {
		const pool = scoredRoot.slice(0, Math.min(3, scoredRoot.length));
		const pick = pool[Math.floor(Math.random() * pool.length)];
		best = pick.move;
		bestScore = pick.score;
	}

	// Convert from side-to-move score to white-perspective score.
	const turn = chess.turn(); // 'w' or 'b'
	const whiteScore = turn === 'w' ? bestScore : -bestScore;
	return { ...moveToBotMove(best), scoreCp: whiteScore };
}

export function searchMove(fen: string, config: BotConfig, remainingMs?: number): BotMove | null {
	return searchWithScore(fen, config, remainingMs);
}

function negamax(chess: Chess, depth: number, alpha: number, beta: number, ply: number, state: SearchState): number {
	state.nodes += 1;
	if (isTimedOut(state)) return 0;
	if (chess.isCheckmate()) return -MATE + ply;
	if (chess.isDraw() || chess.isStalemate() || chess.isInsufficientMaterial()) return 0;

	const alphaOrig = alpha;
	const key = positionKey(chess);
	const ttEntry = state.config.useTT ? state.tt.get(key) : undefined;
	if (ttEntry && ttEntry.depth >= depth) {
		if (ttEntry.flag === 'exact') return ttEntry.score;
		if (ttEntry.flag === 'lower') alpha = Math.max(alpha, ttEntry.score);
		if (ttEntry.flag === 'upper') beta = Math.min(beta, ttEntry.score);
		if (alpha >= beta) return ttEntry.score;
	}

	if (depth <= 0) return quiesce(chess, alpha, beta, ply, state);

	if (state.config.useNullMove && depth >= 3 && !chess.isCheck() && hasNonPawnMaterial(chess)) {
		const nullFen = nullMoveFen(chess.fen());
		if (nullFen) {
			const nullChess = new Chess(nullFen);
			const score = -negamax(nullChess, depth - 3, -beta, -beta + 1, ply + 1, state);
			if (!state.timeout && score >= beta) return beta;
		}
	}

	let bestScore = -INF;
	let bestMove: any;
	const moves = orderMoves(chess, chess.moves({ verbose: true }), state, ttEntry?.best);
	for (const move of moves) {
		play(chess, move);
		const score = -negamax(chess, depth - 1, -beta, -alpha, ply + 1, state);
		chess.undo();
		if (state.timeout) return 0;
		if (score > bestScore) {
			bestScore = score;
			bestMove = move;
		}
		alpha = Math.max(alpha, score);
		if (alpha >= beta) break;
	}

	if (state.config.useTT && bestMove) {
		state.tt.set(key, {
			depth,
			score: bestScore,
			flag: bestScore <= alphaOrig ? 'upper' : bestScore >= beta ? 'lower' : 'exact',
			best: moveKey(bestMove),
		});
	}

	return bestScore;
}

function quiesce(chess: Chess, alpha: number, beta: number, ply: number, state: SearchState): number {
	if (isTimedOut(state)) return 0;
	let standPat = evaluate(chess, state.config);
	if (standPat >= beta) return beta;
	alpha = Math.max(alpha, standPat);
	if (state.config.useQuiescence === 'none') return standPat;

	const moves = chess.moves({ verbose: true }).filter((move: any) => move.captured || (state.config.useQuiescence === 'captures+checks' && move.san.includes('+')));
	for (const move of orderMoves(chess, moves, state, undefined)) {
		play(chess, move);
		const score = -quiesce(chess, -beta, -alpha, ply + 1, state);
		chess.undo();
		if (state.timeout) return 0;
		if (score >= beta) return beta;
		alpha = Math.max(alpha, score);
	}
	return alpha;
}

function evaluate(chess: Chess, config: BotConfig): number {
	let score = 0;
	for (const row of chess.board()) {
		for (const piece of row) {
			if (!piece) continue;
			const sign = piece.color === 'w' ? 1 : -1;
			score += sign * PIECE_VALUE[piece.type];
			if (config.eval.pst) score += sign * pstBonus(piece.type, piece.color, piece.square ?? 'a1');
		}
	}
	if (config.eval.mobility) score += mobilityScore(chess);
	if (config.eval.kingSafety) score += kingSafetyScore(chess);
	if (config.eval.pawnStructure) score += pawnStructureScore(chess);
	if (config.useEndgame) score += endgameScore(chess);
	return chess.turn() === 'w' ? score : -score;
}

function mobilityScore(chess: Chess): number {
	const side = chess.turn();
	const own = chess.moves().length;
	const otherFen = nullMoveFen(chess.fen());
	if (!otherFen) return 0;
	const other = new Chess(otherFen).moves().length;
	return (side === 'w' ? 1 : -1) * (own - other) * 4;
}

function kingSafetyScore(chess: Chess): number {
	let score = 0;
	for (const color of ['w', 'b'] as const) {
		const king = chess.findPiece({ type: 'k', color })[0];
		if (!king) continue;
		const attackers = chess.attackers(king, color === 'w' ? 'b' : 'w').length;
		score += (color === 'w' ? -1 : 1) * attackers * 18;
	}
	return score;
}

function pawnStructureScore(chess: Chess): number {
	const files: Record<string, { w: number; b: number }> = {};
	for (const file of 'abcdefgh') files[file] = { w: 0, b: 0 };
	for (const row of chess.board()) for (const piece of row) if (piece?.type === 'p') files[piece.square[0]][piece.color] += 1;
	let score = 0;
	for (const file of Object.keys(files)) {
		if (files[file].w > 1) score -= 18 * (files[file].w - 1);
		if (files[file].b > 1) score += 18 * (files[file].b - 1);
	}
	return score;
}

function orderMoves(chess: Chess, moves: any[], state: SearchState, ttBest?: string): any[] {
	return [...moves].sort((a, b) => scoreMove(chess, b, ttBest) - scoreMove(chess, a, ttBest));
}

function scoreMove(chess: Chess, move: any, ttBest?: string): number {
	if (ttBest && moveKey(move) === ttBest) return 10_000;
	let score = 0;
	if (move.captured) score += 1000 + (PIECE_VALUE[move.captured] ?? 0) * 10 - (PIECE_VALUE[move.piece] ?? 0);
	if (move.san.includes('#')) score += 50_000;
	if (move.san.includes('+')) score += 100;
	if (move.promotion) score += PIECE_VALUE[move.promotion] ?? 0;
	return score;
}

function play(chess: Chess, move: any): void {
	chess.move(move.promotion ? { from: move.from, to: move.to, promotion: move.promotion } : { from: move.from, to: move.to });
}

function moveToBotMove(move: any): BotMove {
	return { from: move.from, to: move.to, promotion: move.promotion as BotMove['promotion'] };
}

function moveKey(move: any): string {
	return `${move.from}${move.to}${move.promotion ?? ''}`;
}

function isTimedOut(state: SearchState): boolean {
	if (Date.now() > state.deadline) state.timeout = true;
	return state.timeout;
}

function nullMoveFen(fen: string): string | null {
	const parts = fen.split(' ');
	if (parts.length < 6) return null;
	parts[1] = parts[1] === 'w' ? 'b' : 'w';
	parts[3] = '-';
	parts[4] = String(Number(parts[4] || '0') + 1);
	return parts.join(' ');
}

function hasNonPawnMaterial(chess: Chess): boolean {
	for (const row of chess.board()) for (const piece of row) if (piece && piece.type !== 'p' && piece.type !== 'k') return true;
	return false;
}

function pstBonus(type: string, color: string, square: string): number {
	const file = square.charCodeAt(0) - 97;
	const rank = Number(square[1]) - 1;
	const r = color === 'w' ? rank : 7 - rank;
	const center = 14 - (Math.abs(file - 3.5) + Math.abs(r - 3.5)) * 4;
	if (type === 'n') return center * 5;
	if (type === 'b') return center * 3;
	if (type === 'p') return r * 8 - Math.abs(file - 3.5) * 2;
	if (type === 'r') return r >= 6 ? 10 : 0;
	if (type === 'k') return r <= 1 ? 12 : -center * 2;
	return center;
}
