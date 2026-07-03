import type { Chess } from 'chess.js';

type Color = 'w' | 'b';

export function endgameScore(chess: Chess): number {
	const material = countMaterial(chess);
	const whiteHeavy = material.w.q + material.w.r;
	const blackHeavy = material.b.q + material.b.r;
	const whiteMinor = material.w.n + material.w.b + material.w.p;
	const blackMinor = material.b.n + material.b.b + material.b.p;

	let score = 0;
	if (whiteHeavy > 0 && blackHeavy === 0 && blackMinor === 0) score += driveKing(chess, 'w');
	if (blackHeavy > 0 && whiteHeavy === 0 && whiteMinor === 0) score -= driveKing(chess, 'b');
	return score;
}

function countMaterial(chess: Chess) {
	const count = {
		w: { p: 0, n: 0, b: 0, r: 0, q: 0 },
		b: { p: 0, n: 0, b: 0, r: 0, q: 0 },
	};
	for (const row of chess.board()) {
		for (const piece of row) {
			if (piece && piece.type !== 'k') count[piece.color][piece.type] += 1;
		}
	}
	return count;
}

function driveKing(chess: Chess, stronger: Color): number {
	const weaker = stronger === 'w' ? 'b' : 'w';
	const strongKing = chess.findPiece({ type: 'k', color: stronger })[0];
	const weakKing = chess.findPiece({ type: 'k', color: weaker })[0];
	if (!strongKing || !weakKing) return 0;
	const weak = squareCoords(weakKing);
	const strong = squareCoords(strongKing);
	const edgeDistance = Math.min(weak.file, 7 - weak.file, weak.rank, 7 - weak.rank);
	const kingDistance = Math.abs(weak.file - strong.file) + Math.abs(weak.rank - strong.rank);
	return (3 - edgeDistance) * 28 + (14 - kingDistance) * 8;
}

function squareCoords(square: string) {
	return { file: square.charCodeAt(0) - 97, rank: Number(square[1]) - 1 };
}
