// Structured logging for Workers Logpush / Cloudflare Observability (QR-18).
// All log lines are emitted as JSON so they are queryable by field in the dashboard.
// Workers Observability is enabled via `"observability": { "enabled": true }` in wrangler.jsonc.

type LogLevel = 'info' | 'warn' | 'error';

function emit(level: LogLevel, event: string, fields: Record<string, unknown>) {
	const entry = { level, event, ...fields, ts: new Date().toISOString() };
	if (level === 'error') console.error(JSON.stringify(entry));
	else if (level === 'warn') console.warn(JSON.stringify(entry));
	else console.log(JSON.stringify(entry));
}

export const log = {
	info: (event: string, fields: Record<string, unknown> = {}) => emit('info', event, fields),
	warn: (event: string, fields: Record<string, unknown> = {}) => emit('warn', event, fields),
	error: (event: string, fields: Record<string, unknown> = {}) => emit('error', event, fields),
};
