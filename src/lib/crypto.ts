// Web Crypto helpers for QR-1 identity hardening: secret hashing + signed-cookie
// HMAC. Runs in workerd (no Node crypto). base64url is URL-safe with no padding.

/**
 * SHA-256 hash a value and return it as a lowercase hex string.
 *
 * Used to store account-recovery secrets (`cfk_…`) so the plaintext is never
 * persisted — only this hash is written to D1.
 *
 * @param secret - The plaintext value to hash.
 * @returns The hex-encoded SHA-256 digest.
 */
export async function hashSecret(secret: string): Promise<string> {
	const encoder = new TextEncoder();
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
	return arrayBufferToHex(digest);
}

/**
 * Constant-time string comparison to prevent timing side-channel attacks when
 * comparing signatures or secrets. workerd does not expose Node's
 * `crypto.timingSafeEqual`, so this manually XOR-accumulates over both
 * buffers rather than short-circuiting on the first mismatch.
 *
 * @param a - First string to compare.
 * @param b - Second string to compare.
 * @returns `true` only if both strings have equal length and identical bytes.
 */
export function timingSafeEqual(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);
	if (aBytes.length !== bBytes.length) return false;

	let acc = 0;
	for (let i = 0; i < aBytes.length; i++) {
		acc |= aBytes[i] ^ bBytes[i];
	}
	return acc === 0;
}

/**
 * Sign a message with HMAC-SHA256 using the Web Crypto API.
 *
 * @param key - The signing key (typically `AUTH_SECRET`).
 * @param message - The message to sign (typically a player handle).
 * @returns A base64url-encoded signature (URL-safe, no padding).
 */
export async function hmacSign(key: string, message: string): Promise<string> {
	const encoder = new TextEncoder();
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		encoder.encode(key),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
	return base64urlEncode(signature);
}

/**
 * Verify an HMAC-SHA256 signature in constant time.
 *
 * @param key - The signing key (typically `AUTH_SECRET`).
 * @param message - The original signed message.
 * @param signature - The base64url signature to verify.
 * @returns `true` if the signature is valid for the given key and message.
 */
export async function hmacVerify(key: string, message: string, signature: string): Promise<boolean> {
	const expected = await hmacSign(key, message);
	return timingSafeEqual(expected, signature);
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function base64urlEncode(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
