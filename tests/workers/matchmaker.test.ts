import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

function matchmaker() {
	const id = env.MATCHMAKER.idFromName(`mm-${crypto.randomUUID()}`);
	return env.MATCHMAKER.get(id);
}

describe('Matchmaker.recordGame idempotency (QR-5)', () => {
	it('applies a rated result exactly once for duplicate calls', async () => {
		const mm = matchmaker();
		const a = await mm.mintPlayerId('Alice');
		const b = await mm.mintPlayerId('Bob');
		const matchId = crypto.randomUUID();
		const payload = {
			matchId,
			whiteId: a.playerId,
			blackId: b.playerId,
			whiteName: 'Alice',
			blackName: 'Bob',
			result: '1-0' as const,
		};

		const r1 = await mm.recordGame(payload);
		const r2 = await mm.recordGame(payload); // retry — must be a no-op

		expect(r1.white.delta).toBeGreaterThan(0);
		expect(r2.white.rating).toBe(r1.white.rating);
		expect(r2.black.rating).toBe(r1.black.rating);

		const pa = await mm.getProfileBundle(a.playerId);
		const pb = await mm.getProfileBundle(b.playerId);
		expect(pa!.profile.games).toBe(1);
		expect(pa!.profile.wins).toBe(1);
		expect(pb!.profile.games).toBe(1);
		expect(pb!.profile.losses).toBe(1);
		// History recorded once per player, not twice.
		expect(pa!.recent).toHaveLength(1);
	});

	it('records a bot game once and leaves Elo unchanged', async () => {
		const mm = matchmaker();
		const human = await mm.mintPlayerId('Carol');
		const matchId = crypto.randomUUID();
		const payload = {
			matchId,
			whiteId: human.playerId,
			blackId: 'bot:edge-knight',
			whiteName: 'Carol',
			blackName: 'Edge Knight',
			result: '1-0' as const,
		};

		await mm.recordGame(payload);
		await mm.recordGame(payload); // retry

		const p = await mm.getProfileBundle(human.playerId);
		expect(p!.profile.rating).toBe(1200); // bot games never affect Elo
		expect(p!.profile.games).toBe(0); // not a rated game
		expect(p!.profile.botGames).toBe(1); // counted exactly once
		expect(p!.profile.botWins).toBe(1);
	});
});
