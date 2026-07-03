import { describe, expect, it } from 'vitest';
import { START_FEN } from '../../src/lib/chess/engine';

describe('test harness', () => {
	it('resolves src + chess.js and exposes the start position', () => {
		expect(START_FEN).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
	});
});
