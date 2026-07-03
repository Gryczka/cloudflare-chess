/**
 * Worker entry point for the Cloudflare Chess platform.
 *
 * This module has two responsibilities:
 * 1. Re-export the three Durable Object classes so the Workers runtime can
 *    bind to them (see `wrangler.jsonc` → `durable_objects.bindings`).
 * 2. Provide the default export required by `@astrojs/cloudflare`: it wraps
 *    the generated Astro SSR handler and adds a `queue()` consumer for
 *    asynchronous post-game AI analysis.
 *
 * Request flow: HTTP/WebSocket requests are handled by Astro's SSR fetch
 * handler (spread in below); Durable Object RPC calls route directly to
 * `ChessMatch`, `Matchmaker`, or `GameLobby` from API routes. Post-game
 * analysis is decoupled via a Cloudflare Queue so it never blocks game end.
 */
export { ChessMatch } from './lib/durable-objects/chess-match';
export { Matchmaker } from './lib/durable-objects/matchmaker';
export { GameLobby } from './lib/durable-objects/game-lobby';

// Queue consumer for post-game AI analysis.
// Processes messages from game-analysis-queue, calls Workers AI (via AI Gateway),
// and stores structured coaching output in R2 at analysis/{matchId}.json.
import { log } from './lib/log';
import { indexGame } from './lib/d1/positions';

type AnalysisMessage = {
	matchId: string;
	whiteName: string;
	blackName: string;
	whiteRating: number;
	blackRating: number;
	result: string;
	reason: string;
	pgn: string;
	plyCount: number;
};

type CoachResponse = {
	openingName: string;
	summary: string;
	keyMoment: string;
	tip: string;
	accuracy?: { white: number; black: number };
};

/**
 * Ask Workers AI (via AI Gateway) to analyze a completed game and return
 * structured coaching feedback.
 *
 * @param env - Worker bindings (uses `env.AI` routed through the AI Gateway).
 * @param msg - The queued analysis message (PGN, players, ratings, result).
 * @returns Parsed coaching JSON: opening name, summary, key moment, tip, and
 *   an optional rough accuracy estimate for each side.
 * @throws If the model response cannot be parsed as JSON.
 */
async function analyzeGame(env: Env, msg: AnalysisMessage): Promise<CoachResponse> {
	const resultText =
		msg.result === '1-0' ? `${msg.whiteName} (white) won` :
		msg.result === '0-1' ? `${msg.blackName} (black) won` :
		'the game was drawn';
	const prompt = `You are a chess coach reviewing a completed game. Analyze the following game and provide structured feedback.

Game details:
- White: ${msg.whiteName} (${msg.whiteRating} Elo)
- Black: ${msg.blackName} (${msg.blackRating} Elo)
- Result: ${resultText} by ${msg.reason}
- Total moves: ${Math.ceil(msg.plyCount / 2)}

PGN:
${msg.pgn}

Respond with a JSON object (no markdown, no extra text) with exactly these fields:
{
  "openingName": "name of the opening played (e.g. Sicilian Defense, Ruy Lopez)",
  "summary": "2-3 sentence game summary for a club player",
  "keyMoment": "describe the single most critical move or turning point",
  "tip": "one actionable improvement tip for the losing player (or both if draw)",
  "accuracy": { "white": 75, "black": 68 }
}
Accuracy is a rough estimate from 0-100 based on move quality. Respond only with valid JSON.`;

	// Route through AI Gateway for caching + observability (P4-D).
	// The AI Gateway slug is 'cf-chess-gateway'; configure it in the Cloudflare dashboard.
	const aiResponse = await (env.AI as Ai).run('@cf/meta/llama-3.1-8b-instruct', {
		prompt,
		max_tokens: 512,
		stream: false,
	}, {
		gateway: {
			id: 'cf-chess-gateway',
			skipCache: false,
			cacheTtl: 86400, // cache identical PGN analyses for 24h
		},
	});

	// Parse the model's JSON response
	const responseText = typeof aiResponse === 'object' && 'response' in aiResponse
		? String((aiResponse as { response: string }).response)
		: '';

	// Extract JSON from the response (model may include extra whitespace)
	const jsonMatch = responseText.match(/\{[\s\S]*\}/);
	if (!jsonMatch) throw new Error(`Invalid AI response: ${responseText.slice(0, 200)}`);
	return JSON.parse(jsonMatch[0]) as CoachResponse;
}

export default {
	// Astro SSR handler (delegated to @astrojs/cloudflare)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	...(await import('@astrojs/cloudflare/entrypoints/server')).default as any,

	/**
	 * Queue consumer for `game-analysis-queue`.
	 *
	 * For each completed rated human-vs-human game: runs AI coaching analysis,
	 * writes the result to R2 (`analysis/{matchId}.json`), and indexes the
	 * game's positions into D1 for the opening explorer. Failed messages are
	 * retried by returning `message.retry()`.
	 */
	async queue(batch: MessageBatch<AnalysisMessage>, env: Env): Promise<void> {
		for (const message of batch.messages) {
			const msg = message.body;
			try {
				log.info('analysis.processing', { matchId: msg.matchId });
				const coach = await analyzeGame(env, msg);
				const analysisRecord = {
					matchId: msg.matchId,
					generatedAt: Date.now(),
					...coach,
				};
				// Store in R2 alongside PGN/JSON archives
				if (env.R2_ARCHIVE) {
					await env.R2_ARCHIVE.put(
						`analysis/${msg.matchId}.json`,
						JSON.stringify(analysisRecord),
						{ httpMetadata: { contentType: 'application/json' } },
					);
				}

				// P5-C: index game positions for opening explorer.
				// Read moves from R2 archive (already written by endGame).
				if (env.R2_ARCHIVE && env.DB) {
					const archiveObj = await env.R2_ARCHIVE.get(`games/${msg.matchId}.json`);
					if (archiveObj) {
						const archive = await archiveObj.json<{
							moves: Array<{ fen: string; uci: string }>;
							result: string;
						}>();
						await indexGame(env.DB, archive.moves, archive.result as import('./lib/messages').GameResult);
						log.info('analysis.positions_indexed', { matchId: msg.matchId, plies: archive.moves.length });
					}
				}

				log.info('analysis.complete', { matchId: msg.matchId });
				message.ack();
			} catch (error) {
				log.error('analysis.failed', { matchId: msg.matchId, error: String(error) });
				message.retry();
			}
		}
	},
};
