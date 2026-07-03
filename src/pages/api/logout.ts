import type { APIRoute } from 'astro';
import { clearSessionCookie, isRequestSecure } from '../../lib/identity';

export const prerender = false;

export const POST: APIRoute = ({ request }) => {
	const headers = new Headers();
	for (const cookie of clearSessionCookie({ secure: isRequestSecure(request) })) {
		headers.append('Set-Cookie', cookie);
	}
	return Response.json({ ok: true }, { headers });
};
