import { Chess } from 'chess.js';
import { positionKey } from './bot-position-key';

const book = new Map<string, string[]>();

const lines = [
	['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'],
	['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'],
	['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4'],
	['e4', 'c5', 'Nf3', 'Nc6', 'd4', 'cxd4'],
	['e4', 'e6', 'd4', 'd5', 'Nc3', 'Nf6'],
	['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4'],
	['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6'],
	['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7'],
	['c4', 'Nf6', 'Nc3', 'e5', 'g3', 'd5'],
	['Nf3', 'd5', 'g3', 'Nf6', 'Bg2', 'g6'],
];

for (const line of lines) {
	const chess = new Chess();
	for (const san of line) {
		const key = positionKey(chess);
		const moves = book.get(key) ?? [];
		if (!moves.includes(san)) moves.push(san);
		book.set(key, moves);
		try {
			chess.move(san);
		} catch {
			break;
		}
	}
}

export function bookMove(fen: string): { from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' } | null {
	const chess = new Chess(fen);
	const moves = book.get(positionKey(chess));
	if (!moves?.length) return null;
	const san = moves[Math.floor(Math.random() * moves.length)];
	const move = chess.move(san);
	return { from: move.from, to: move.to, promotion: move.promotion as 'q' | 'r' | 'b' | 'n' | undefined };
}
