// Minimal worker entry for Durable Object integration tests.
// Exports the DO classes without pulling in the full Astro SSR handler
// (which expects the built dist/ manifest and isn't needed for DO tests).
export { ChessMatch } from '../../src/lib/durable-objects/chess-match';
export { Matchmaker } from '../../src/lib/durable-objects/matchmaker';
export { GameLobby } from '../../src/lib/durable-objects/game-lobby';

export default {
	async fetch(): Promise<Response> {
		return new Response('test worker');
	},
};
