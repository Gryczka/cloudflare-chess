/**
 * Anonymous session identity (QR-1): signed, HttpOnly cookie helpers.
 *
 * The player's handle (e.g. `bold-rook-4821`) is public and never secret — it
 * is embedded in the cookie in plaintext. What makes the cookie trustworthy is
 * the HMAC-SHA256 signature appended after a `.`; only the server (holding
 * `AUTH_SECRET`) can produce a valid signature, so the handle cannot be
 * spoofed by a client editing their cookie. Account *recovery* uses a
 * separate high-entropy secret (`cfk_…`, see `player-id.ts`) that is never
 * stored in plaintext — only its SHA-256 hash is persisted.
 */
import { hmacSign, hmacVerify } from './crypto';
import { isValidPlayerId } from './player-id';

const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
const DEV_AUTH_SECRET = 'dev-insecure-auth-secret-change-me';
const HOST_COOKIE_NAME = '__Host-cf_chess_session';
const PLAIN_COOKIE_NAME = 'cf_chess_session';

let warned = false;

/**
 * Resolve the authenticated player handle from the request's signed session
 * cookie. The handle is public, but the cookie is HMAC-signed + HttpOnly so
 * it cannot be forged: any downstream role derivation from the returned
 * handle is therefore safe.
 *
 * @param request - The incoming request (its `Cookie` header is inspected).
 * @param secret - The server's `AUTH_SECRET` used to verify the signature.
 * @returns The verified player handle, or `undefined` if there is no cookie,
 *   it is malformed, or the signature does not verify.
 */
export async function resolvePlayerId(request: Request, secret: string): Promise<string | undefined> {
	const cookies = parseCookie(request.headers.get('Cookie') ?? '');
	const token = cookies[HOST_COOKIE_NAME] ?? cookies[PLAIN_COOKIE_NAME];
	if (!token) return undefined;

	const dot = token.lastIndexOf('.');
	if (dot === -1) return undefined;

	const publicId = token.slice(0, dot);
	const signature = token.slice(dot + 1);
	if (!isValidPlayerId(publicId)) return undefined;

	const ok = await hmacVerify(authSecret(secret), publicId, signature);
	return ok ? publicId : undefined;
}

/**
 * Mint a signed `Set-Cookie` header value for a player's session.
 *
 * @param publicId - The player's public handle (must pass `isValidPlayerId`).
 * @param secret - The server's `AUTH_SECRET` used to sign the cookie.
 * @param options.secure - Whether the request was served over HTTPS; when
 *   true the `__Host-` cookie name and `Secure` flag are used.
 * @returns A complete `Set-Cookie` header value ready to attach to a Response.
 * @throws If `publicId` is not a valid player handle.
 */
export async function createSessionCookie(
	publicId: string,
	secret: string,
	{ secure }: { secure: boolean },
): Promise<string> {
	if (!isValidPlayerId(publicId)) throw new Error('Invalid player ID for session cookie');

	const token = `${publicId}.${await hmacSign(authSecret(secret), publicId)}`;
	const name = secure ? HOST_COOKIE_NAME : PLAIN_COOKIE_NAME;
	const flags = `Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
	return `${name}=${encodeURIComponent(token)}; ${flags}`;
}

/**
 * Build `Set-Cookie` values that clear both possible session cookie names, so
 * logout works regardless of which scheme (`__Host-` vs plain) the session
 * was originally minted under.
 *
 * @returns An array of two `Set-Cookie` header values to attach to a Response.
 */
export function clearSessionCookie({ secure }: { secure: boolean }): string[] {
	const flags = `Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
	return [`${HOST_COOKIE_NAME}=; ${flags}`, `${PLAIN_COOKIE_NAME}=; ${flags}`];
}

export function isRequestSecure(request: Request): boolean {
	const url = new URL(request.url);
	if (url.protocol === 'https:') return true;
	return request.headers.get('x-forwarded-proto') === 'https';
}

export function safeUsername(value: string | null | undefined): string {
	// Strip control chars and HTML/JS-dangerous characters (defense-in-depth on
	// top of output escaping — QR-2), collapse whitespace, and cap length.
	const name = (value ?? '')
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f<>&"'`\\]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 24);
	return name || `Player ${Math.floor(Math.random() * 9000 + 1000)}`;
}

function authSecret(secret: string): string {
	const effective = secret || DEV_AUTH_SECRET;
	// Warn loudly if the signing key is the known, in-repo dev literal (empty or
	// the placeholder value) — cookies signed with it are trivially forgeable, so
	// production MUST override AUTH_SECRET with a real secret.
	if (!warned && effective === DEV_AUTH_SECRET) {
		warned = true;
		console.warn('[cf-chess] AUTH_SECRET is unset or the insecure dev default; session cookies are forgeable. Set a real AUTH_SECRET in production (wrangler secret put AUTH_SECRET).');
	}
	return effective;
}

function parseCookie(header: string): Record<string, string> {
	return Object.fromEntries(
		header
			.split(';')
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => {
				const index = part.indexOf('=');
				if (index === -1) return [part, ''];
				const key = part.slice(0, index);
				const value = part.slice(index + 1);
				// A single malformed cookie anywhere on the origin must not throw and
				// turn an auth check into a 500 — fall back to the raw value.
				try {
					return [key, decodeURIComponent(value)];
				} catch {
					return [key, value];
				}
			}),
	);
}
