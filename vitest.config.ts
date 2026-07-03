import { defineConfig } from 'vitest/config';

// Plain Node project for pure unit tests (engine, bot, Elo, helpers).
// Durable Object / WebSocket integration tests live in vitest.workers.config.ts
// and run inside workerd via @cloudflare/vitest-pool-workers.
export default defineConfig({
	test: {
		include: ['tests/unit/**/*.test.ts'],
		environment: 'node',
	},
});
