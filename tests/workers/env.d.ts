/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Type the `env` exported from 'cloudflare:test' with the Worker's bindings
// (CHESS_MATCH, MATCHMAKER, ...) generated in worker-configuration.d.ts.
declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}
