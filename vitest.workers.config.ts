import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Durable Object / WebSocket / alarm integration tests run inside workerd,
// with real DO bindings sourced from wrangler.jsonc. We point `main` at a
// minimal entry that exports only the DO classes (not the Astro SSR handler).
export default defineConfig({
	plugins: [
		cloudflareTest({
			main: './tests/workers/worker-entry.ts',
			wrangler: { configPath: './wrangler.jsonc' },
			// Disable remote binding validation — KV/Queue/AI use placeholder IDs
			// that don't exist in the Cloudflare account, so remote proxy would fail.
			remoteBindings: false,
		}),
	],
	test: {
		include: ['tests/workers/**/*.test.ts'],
		setupFiles: ['./tests/workers/setup.ts'],
	},
});
