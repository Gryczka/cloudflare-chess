import type { Chess } from 'chess.js';

export function positionKey(chess: Chess): string {
	const [board, turn, castling, ep] = chess.fen().split(' ');
	return `${board} ${turn} ${castling} ${ep}`;
}
