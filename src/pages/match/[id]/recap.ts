// P4-F: GET /match/:id/recap — returns a PNG screenshot of the final board position.
// Uses Browser Rendering (puppeteer) to render /match/:id/board, screenshots it,
// stores the PNG in R2 at recaps/{matchId}.png, and redirects to R2 public URL.
// On subsequent calls, serves the cached PNG from R2 directly (no re-render needed).
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

export const GET: APIRoute = async ({ params, request }) => {
	const matchId = params.id ?? '';
	if (!matchId) return new Response('Missing match ID', { status: 400 });

	const r2Key = `recaps/${matchId}.png`;

	// Serve from R2 cache if already rendered.
	if (env.R2_ARCHIVE) {
		const cached = await env.R2_ARCHIVE.get(r2Key);
		if (cached) {
			return new Response(cached.body, {
				headers: {
					'Content-Type': 'image/png',
					'Cache-Control': 'public, max-age=2592000, immutable',
				},
			});
		}
	}

	// Fetch game state to get final FEN + player names + result.
	let fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
	let white = 'White';
	let black = 'Black';
	let result = '';
	try {
		const gameState = await env.CHESS_MATCH.getByName(matchId).getState();
		if (!('status' in gameState) || gameState.status !== 'not_found') {
			const state = gameState as import('../../../lib/messages').GameState;
			fen = state.fen;
			white = state.whiteName;
			black = state.blackName;
			result = state.result ?? '';
		}
	} catch { /* fall back to start position */ }

	// Render board using Browser Rendering.
	if (!env.BROWSER) {
		return new Response('Browser Rendering not configured', { status: 503 });
	}

	try {
		const puppeteer = await import('@cloudflare/puppeteer');
		const browser = await puppeteer.default.launch(env.BROWSER);
		const page = await browser.newPage();
		await page.setViewport({ width: 540, height: 580 });

		const boardUrl = new URL(`/match/${matchId}/board`, new URL(request.url).origin);
		boardUrl.searchParams.set('fen', fen);
		boardUrl.searchParams.set('result', result);
		boardUrl.searchParams.set('white', white);
		boardUrl.searchParams.set('black', black);

		await page.goto(boardUrl.toString(), { waitUntil: 'networkidle0' });

		const screenshotBuffer = await page.screenshot({ type: 'png' });
		await browser.close();
		// Convert Buffer to Uint8Array for BodyInit / R2 compatibility.
		const screenshot = new Uint8Array(screenshotBuffer);

		// Store in R2 for future requests.
		if (env.R2_ARCHIVE) {
			await env.R2_ARCHIVE.put(r2Key, screenshot, {
				httpMetadata: { contentType: 'image/png' },
			});
		}

		return new Response(screenshot, {
			headers: {
				'Content-Type': 'image/png',
				'Cache-Control': 'public, max-age=2592000, immutable',
			},
		});
	} catch (error) {
		return new Response(`Recap generation failed: ${error}`, { status: 500 });
	}
};
