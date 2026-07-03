type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

declare namespace App {
	interface Locals extends Runtime {}
}

// QR-9: optional rate-limit + Turnstile bindings. They are absent in local dev
// and CI — all code paths must no-op gracefully when undefined.
// Real values come from wrangler.jsonc rate_limiting[].binding + wrangler secret.
// Augmenting Cloudflare.Env (not the global Env alias) because worker-configuration.d.ts
// declares `interface Env extends Cloudflare.Env {}` — merging here propagates everywhere.
// UX-6: recovery key dialog — exposed by Layout.astro inline script
interface Window {
	__showRecoveryKey?: (secret: string) => void;
}

// cm-chessboard Markers extension has no TypeScript declarations.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare module 'cm-chessboard/src/extensions/markers/Markers.js';

declare namespace Cloudflare {
	interface Env {
		RATE_LIMIT_ENROLL?: import('./lib/rate-limit').RateLimiter;
		RATE_LIMIT_LOGIN?: import('./lib/rate-limit').RateLimiter;
	}
}
