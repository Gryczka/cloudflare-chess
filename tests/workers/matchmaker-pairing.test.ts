import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// Each test gets its own fresh Matchmaker DO instance (isolated UUID name) so
// recorded games from one test never bleed into another's state.
function matchmaker() {
	const id = env.MATCHMAKER.idFromName(`mm-${crypto.randomUUID()}`);
	return env.MATCHMAKER.get(id);
}

describe('Matchmaker pairing + leaderboard', () => {
	it('mints two distinct player IDs with starting rating 1200', async () => {
		const mm = matchmaker();
		const alice = await mm.mintPlayerId('Alice');
		const bob = await mm.mintPlayerId('Bob');

		expect(typeof alice.playerId).toBe('string');
		expect(typeof bob.playerId).toBe('string');
		expect(alice.playerId).not.toBe(bob.playerId);
		expect(alice.profile.rating).toBe(1200);
		expect(bob.profile.rating).toBe(1200);
	});

	it('getProfileBundle returns the profile and empty recent history for a new player', async () => {
		const mm = matchmaker();
		const { playerId } = await mm.mintPlayerId('Carol');
		const bundle = await mm.getProfileBundle(playerId);

		expect(bundle).not.toBeNull();
		expect(bundle!.profile.games).toBe(0);
		expect(bundle!.recent).toEqual([]);
	});

	it('recordGame updates Elo and win/loss record for both players', async () => {
		const mm = matchmaker();
		const white = await mm.mintPlayerId('White');
		const black = await mm.mintPlayerId('Black');

		const update = await mm.recordGame({
			matchId: crypto.randomUUID(),
			whiteId: white.playerId,
			blackId: black.playerId,
			whiteName: 'White',
			blackName: 'Black',
			result: '1-0',
		});

		// At equal 1200 ratings, k-factor=40 * (1 - 0.5) = 20 exactly.
		expect(update.white.delta).toBe(20);
		expect(update.black.delta).toBe(-20);

		const pw = await mm.getProfileBundle(white.playerId);
		const pb = await mm.getProfileBundle(black.playerId);

		expect(pw!.profile.wins).toBe(1);
		expect(pw!.profile.losses).toBe(0);
		expect(pb!.profile.losses).toBe(1);
		expect(pb!.profile.wins).toBe(0);
	});

	it('leaderboard requires ≥10 games and entries have correct shape', async () => {
		const mm = matchmaker();
		const a = await mm.mintPlayerId('AlphaPlayer');
		const b = await mm.mintPlayerId('BetaPlayer');

		// Record 10 games — all won by A. A's rating diverges well above B.
		for (let i = 0; i < 10; i++) {
			await mm.recordGame({
				matchId: crypto.randomUUID(),
				whiteId: a.playerId,
				blackId: b.playerId,
				whiteName: 'AlphaPlayer',
				blackName: 'BetaPlayer',
				result: '1-0',
			});
		}

		const board = await mm.getLeaderboard();

		// Both players now have ≥10 games and appear on the board.
		expect(board.length).toBeGreaterThanOrEqual(2);

		// Verify entry shape (not ordering — SQLite tie-breaking is undefined).
		for (const entry of board) {
			expect(entry).toHaveProperty('rank');
			expect(entry).toHaveProperty('playerId');
			expect(entry).toHaveProperty('username');
			expect(typeof entry.rating).toBe('number');
			expect(typeof entry.winRate).toBe('number');
		}

		// A wins should push their rating higher than B — assert no tie after 10 wins.
		const aEntry = board.find((e) => e.playerId === a.playerId)!;
		const bEntry = board.find((e) => e.playerId === b.playerId)!;
		expect(aEntry.rating).toBeGreaterThan(bEntry.rating);
	});

	it('getProfileBundle.recent is capped by the limit parameter', async () => {
		const mm = matchmaker();
		const human = await mm.mintPlayerId('Human');

		// Record 12 bot games — more than the default limit of 10.
		for (let i = 0; i < 12; i++) {
			await mm.recordGame({
				matchId: crypto.randomUUID(),
				whiteId: human.playerId,
				blackId: 'bot:edge-knight',
				whiteName: 'Human',
				blackName: 'Edge Knight',
				result: '1-0',
			});
		}

		const bundle = await mm.getProfileBundle(human.playerId, 10);
		expect(bundle).not.toBeNull();
		expect(bundle!.recent).toHaveLength(10);
		expect(bundle!.profile.botGames).toBe(12);
	});
});
