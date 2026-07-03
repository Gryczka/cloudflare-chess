/**
 * Anonymous identity primitives (QR-1): public handle generation/validation
 * and high-entropy recovery secret generation/validation.
 *
 * There are two distinct credentials in this system:
 * - **Handle** (`adjective-noun-NNNN`) — public, human-readable, safe to
 *   display anywhere (chat, leaderboard, match pages).
 * - **Secret** (`cfk_…`) — a 256-bit random recovery credential shown to the
 *   player exactly once at account creation. Only its SHA-256 hash (see
 *   `crypto.ts#hashSecret`) is ever persisted server-side.
 */

const adjectives = [
	'bold',
	'calm',
	'clever',
	'cunning',
	'daring',
	'gambit',
	'lucky',
	'nimble',
	'patient',
	'sharp',
	'silent',
	'steady',
	'swift',
	'tactical',
	'vibing',
];

const nouns = [
	'bishop',
	'castler',
	'gambit',
	'knight',
	'pawn',
	'queen',
	'rook',
	'sentinel',
	'strategist',
	'tactician',
	'tempo',
];

/**
 * Generate a new random public player handle, e.g. `bold-rook-4821`.
 *
 * Not guaranteed globally unique on its own — callers should retry against
 * their datastore on collision (see `Matchmaker.mintPlayerId`).
 */
export function generatePlayerId(): string {
	return `${pick(adjectives)}-${pick(nouns)}-${randomNumber()}`;
}

/**
 * Type-guard: does `value` look like a well-formed player handle
 * (`adjective-noun-NNNN`)? Does not check whether the handle exists.
 */
export function isValidPlayerId(value: string | undefined | null): value is string {
	return typeof value === 'string' && /^[a-z]+-[a-z]+-\d{4}$/.test(value);
}

/**
 * Generate a new high-entropy account-recovery secret, e.g. `cfk_AbC123...`.
 *
 * This is the ONLY credential that can be used to log back into an account.
 * Callers must display it to the user exactly once and never log or persist
 * the plaintext value — only `hashSecret()`'s output should be stored.
 */
export function generateSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return `cfk_${base64UrlEncode(bytes)}`;
}

/**
 * Type-guard: does `value` look like a well-formed recovery secret
 * (`cfk_` prefix + 32-128 base64url characters)?
 */
export function isValidSecret(value: string | undefined | null): value is string {
	return typeof value === 'string' && /^cfk_[A-Za-z0-9_-]{32,128}$/.test(value);
}

function pick<T>(items: T[]): T {
	return items[Math.floor(Math.random() * items.length)];
}

function randomNumber(): number {
	return Math.floor(Math.random() * 9000) + 1000;
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
