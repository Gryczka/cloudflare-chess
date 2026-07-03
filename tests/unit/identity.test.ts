import { describe, expect, it } from 'vitest';
import { clearSessionCookie, createSessionCookie, isRequestSecure, resolvePlayerId } from '../../src/lib/identity';
import { generateSecret, isValidSecret } from '../../src/lib/player-id';
import { hashSecret, hmacSign, hmacVerify, timingSafeEqual } from '../../src/lib/crypto';

const ID = 'tactical-knight-2048';
const cookiePair = (setCookie: string) => setCookie.split(';')[0];

describe('crypto (QR-1)', () => {
	it('HMAC sign/verify round-trips and rejects tampering / wrong key', async () => {
		const sig = await hmacSign('key', 'msg');
		expect(await hmacVerify('key', 'msg', sig)).toBe(true);
		expect(await hmacVerify('key', 'msg2', sig)).toBe(false);
		expect(await hmacVerify('other', 'msg', sig)).toBe(false);
	});

	it('hashSecret is deterministic SHA-256 hex', async () => {
		const h = await hashSecret('cfk_abc');
		expect(h).toMatch(/^[0-9a-f]{64}$/);
		expect(await hashSecret('cfk_abc')).toBe(h);
	});

	it('timingSafeEqual compares value and length', () => {
		expect(timingSafeEqual('abc', 'abc')).toBe(true);
		expect(timingSafeEqual('abc', 'abd')).toBe(false);
		expect(timingSafeEqual('abc', 'ab')).toBe(false);
	});
});

describe('secret credential (QR-1)', () => {
	it('generateSecret passes isValidSecret; handles and junk fail', () => {
		expect(isValidSecret(generateSecret())).toBe(true);
		expect(isValidSecret(ID)).toBe(false);
		expect(isValidSecret('cfk_short')).toBe(false);
		expect(isValidSecret(null)).toBe(false);
	});
});

describe('signed session cookie (QR-1)', () => {
	it('round-trips the public handle through a signed secure cookie', async () => {
		const sc = await createSessionCookie(ID, 'k', { secure: true });
		expect(sc.startsWith('__Host-cf_chess_session=')).toBe(true);
		expect(sc).toContain('HttpOnly');
		expect(sc).toContain('Secure');
		const req = new Request('https://x/', { headers: { Cookie: cookiePair(sc) } });
		expect(await resolvePlayerId(req, 'k')).toBe(ID);
	});

	it('uses the non-Secure name for insecure (dev http) contexts', async () => {
		const sc = await createSessionCookie(ID, 'k', { secure: false });
		expect(sc.startsWith('cf_chess_session=')).toBe(true);
		expect(sc).not.toContain('Secure');
		const req = new Request('http://localhost/', { headers: { Cookie: cookiePair(sc) } });
		expect(await resolvePlayerId(req, 'k')).toBe(ID);
	});

	it('rejects a tampered signature and a wrong signing key', async () => {
		const pair = cookiePair(await createSessionCookie(ID, 'k', { secure: true }));
		const tampered = pair.slice(0, -2) + (pair.endsWith('aa') ? 'bb' : 'aa');
		expect(await resolvePlayerId(new Request('https://x/', { headers: { Cookie: tampered } }), 'k')).toBeUndefined();
		expect(await resolvePlayerId(new Request('https://x/', { headers: { Cookie: pair } }), 'wrong-key')).toBeUndefined();
	});

	it('returns undefined for missing/garbage cookies without throwing on bad encoding', async () => {
		expect(await resolvePlayerId(new Request('https://x/'), 'k')).toBeUndefined();
		// 'x=%' is invalid percent-encoding — must not throw (S1).
		const req = new Request('https://x/', { headers: { Cookie: 'x=%; __Host-cf_chess_session=nope' } });
		expect(await resolvePlayerId(req, 'k')).toBeUndefined();
	});

	it('clearSessionCookie expires both cookie names', () => {
		const cleared = clearSessionCookie({ secure: true });
		expect(cleared).toHaveLength(2);
		expect(cleared.every((c) => c.includes('Max-Age=0'))).toBe(true);
		expect(cleared.some((c) => c.startsWith('__Host-cf_chess_session='))).toBe(true);
		expect(cleared.some((c) => c.startsWith('cf_chess_session='))).toBe(true);
	});

	it('isRequestSecure detects https and x-forwarded-proto', () => {
		expect(isRequestSecure(new Request('https://x/'))).toBe(true);
		expect(isRequestSecure(new Request('http://x/'))).toBe(false);
		expect(isRequestSecure(new Request('http://x/', { headers: { 'x-forwarded-proto': 'https' } }))).toBe(true);
	});
});
