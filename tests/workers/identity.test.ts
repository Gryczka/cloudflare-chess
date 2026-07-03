import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

function matchmaker() {
	const id = env.MATCHMAKER.idFromName(`mm-${crypto.randomUUID()}`);
	return env.MATCHMAKER.get(id);
}

describe('Matchmaker identity credentials (QR-1)', () => {
	it('mints a one-time secret and recovers the account via loginWithSecret', async () => {
		const mm = matchmaker();
		const minted = await mm.mintPlayerId('Dana');
		expect(minted.secret).toMatch(/^cfk_[A-Za-z0-9_-]{32,128}$/);
		expect(minted.profile.playerId).toBe(minted.playerId);

		const login = await mm.loginWithSecret(minted.secret);
		expect(login).not.toBeNull();
		expect(login!.playerId).toBe(minted.playerId);
	});

	it('rejects an unknown (well-formed) or malformed secret', async () => {
		const mm = matchmaker();
		await mm.mintPlayerId('Eve');
		expect(await mm.loginWithSecret(`cfk_${'A'.repeat(43)}`)).toBeNull();
		expect(await mm.loginWithSecret('not-a-secret')).toBeNull();
	});

	it('never exposes secretHash in public profile shapes', async () => {
		const mm = matchmaker();
		const minted = await mm.mintPlayerId('Frank');
		expect('secretHash' in (minted.profile as Record<string, unknown>)).toBe(false);
		const bundle = await mm.getProfileBundle(minted.playerId);
		expect(bundle).not.toBeNull();
		expect('secretHash' in (bundle!.profile as Record<string, unknown>)).toBe(false);
	});
});
