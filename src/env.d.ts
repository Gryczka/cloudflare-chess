type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

declare namespace App {
	interface Locals extends Runtime {}
}

// UX-6: recovery key dialog — exposed by Layout.astro inline script
interface Window {
	__showRecoveryKey?: (secret: string) => void;
}

// cm-chessboard Markers extension has no TypeScript declarations.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare module 'cm-chessboard/src/extensions/markers/Markers.js';
