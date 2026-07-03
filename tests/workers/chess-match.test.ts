import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { GameState, MatchInit } from '../../src/lib/messages';

function matchmaker() {
	const id = env.MATCHMAKER.idFromName(`mm-${crypto.randomUUID()}`);
	return env.MATCHMAKER.get(id);
}

function chessMatch(matchId: string) {
	return env.CHESS_MATCH.getByName(matchId);
}

describe('ChessMatch DO', () => {
	it('init creates a game with correct player IDs and starting FEN', async () => {
		const matchId = crypto.randomUUID();
		const cm = chessMatch(matchId);

		const init: MatchInit = {
			matchId,
			whiteId: 'tactical-knight-1111',
			blackId: 'silent-pawn-2222',
			whiteName: 'White',
			blackName: 'Black',
			whiteRating: 1200,
			blackRating: 1200,
			whiteGames: 0,
			blackGames: 0,
			mode: 'rated',
			timeControlMs: 300_000,
		};

		await cm.init(init);
		const state = (await cm.getState()) as GameState;

		expect(state.status).toBe('playing');
		expect(state.whiteId).toBe('tactical-knight-1111');
		expect(state.blackId).toBe('silent-pawn-2222');
		// Starting FEN always begins with the black piece rank.
		expect(state.fen).toMatch(/^rnbqkbnr/);
	});

	it('getState returns not_found for an uninitialised match', async () => {
		const state = await chessMatch(`uninit-${crypto.randomUUID()}`).getState();
		expect(state.status).toBe('not_found');
	});

	it('bot match via matchmaker creates a retrievable game with correct whiteId', async () => {
		const mm = matchmaker();
		const { playerId } = await mm.mintPlayerId('BotBattler');

		const { matchId } = await mm.createBotMatch(playerId, 'BotBattler', 300_000, 'pawn');

		const state = (await chessMatch(matchId).getState()) as GameState;
		expect(state.status).toBe('playing');
		expect(state.whiteId).toBe(playerId);
		expect(state.blackId).toMatch(/^bot:/);
	});

	it('initialising the same matchId twice is idempotent (INSERT OR IGNORE)', async () => {
		const matchId = crypto.randomUUID();
		const cm = chessMatch(matchId);
		const init: MatchInit = {
			matchId,
			whiteId: 'bold-rook-1001',
			blackId: 'swift-bishop-2002',
			whiteName: 'Bold',
			blackName: 'Swift',
			whiteRating: 1200,
			blackRating: 1200,
			whiteGames: 5,
			blackGames: 3,
			mode: 'rated',
			timeControlMs: 180_000,
		};

		await cm.init(init);
		// Second init with different player IDs — should not overwrite.
		await cm.init({ ...init, whiteId: 'other-player-9999', blackId: 'other-player-8888' });
		const state = (await cm.getState()) as GameState;

		expect(state.whiteId).toBe('bold-rook-1001');
	});
});
