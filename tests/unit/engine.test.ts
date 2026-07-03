import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { getEndState, START_FEN, validateMove } from '../../src/lib/chess/engine';

function fenAfter(uciMoves: string[]): string {
	const chess = new Chess();
	for (const uci of uciMoves) {
		chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] as never });
	}
	return chess.fen();
}

describe('validateMove — basic legality', () => {
	it('accepts a legal opening move', () => {
		const move = validateMove(START_FEN, 'e2', 'e4');
		expect(move).not.toBeNull();
		expect(move!.uci).toBe('e2e4');
		expect(move!.turn).toBe('b');
	});

	it('rejects an illegal move', () => {
		expect(validateMove(START_FEN, 'e2', 'e5')).toBeNull();
	});

	it('supports under-promotion to knight', () => {
		const fen = '8/P6k/8/8/8/8/8/7K w - - 0 1';
		const move = validateMove(fen, 'a7', 'a8', 'n');
		expect(move).not.toBeNull();
		expect(move!.uci).toBe('a7a8n');
		expect(move!.fen.startsWith('N')).toBe(true);
	});
});

describe('getEndState — terminal positions', () => {
	it('detects checkmate with the correct winner', () => {
		// Fool's mate: 1. f3 e5 2. g4 Qh4#
		const chess = new Chess();
		for (const uci of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) {
			chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
		}
		const end = getEndState(chess);
		expect(end).toEqual({ ended: true, result: '0-1', reason: 'checkmate' });
	});

	it('detects stalemate', () => {
		const end = getEndState(new Chess('7k/5Q2/5K2/8/8/8/8/8 b - - 0 1'));
		expect(end).toEqual({ ended: true, result: '1/2-1/2', reason: 'stalemate' });
	});

	it('detects insufficient material (K vs K)', () => {
		const end = getEndState(new Chess('8/8/8/4k3/8/4K3/8/8 w - - 0 1'));
		expect(end.ended).toBe(true);
		expect(end).toMatchObject({ result: '1/2-1/2', reason: 'insufficient material' });
	});
});

describe('threefold repetition (QR-4)', () => {
	it('detects a draw by threefold repetition once the position recurs 3x', () => {
		// Knight shuffle returns to the start position every 4 plies.
		// Start counts as occurrence 1; +4 plies = 2; the 8th ply makes it 3.
		const history = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1'];
		const fen = fenAfter(history);
		const move = validateMove(fen, 'f6', 'g8', undefined, history);
		expect(move).not.toBeNull();
		expect(move!.endState.ended).toBe(true);
		expect(move!.endState).toMatchObject({ result: '1/2-1/2' });
		if (move!.endState.ended) {
			expect(move!.endState.reason).toMatch(/threefold/i);
		}
	});

	it('does NOT claim a draw before the 3rd occurrence', () => {
		const history = ['g1f3', 'g8f6', 'f3g1'];
		const fen = fenAfter(history);
		const move = validateMove(fen, 'f6', 'g8', undefined, history); // 2nd occurrence only
		expect(move).not.toBeNull();
		expect(move!.endState.ended).toBe(false);
	});
});
