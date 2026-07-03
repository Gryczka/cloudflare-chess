// P3-E: Apply D1 migrations to the test-time in-memory database before any test runs.
// `applyD1Migrations` is provided by @cloudflare/vitest-pool-workers (cloudflare:test).
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';
import migration0001 from '../../migrations/0001_initial_profiles.sql?raw';
import migration0002 from '../../migrations/0002_opening_positions.sql?raw';

// Split SQL into individual statements for D1Migration.queries (string[]).
// Uses a simple approach: split on ';' that are not inside strings or comments,
// stripping comment lines first.
function splitSqlStatements(sql: string): string[] {
	// Remove line comments first, then split on semicolons.
	const noComments = sql
		.split('\n')
		.filter((line) => !line.trimStart().startsWith('--'))
		.join('\n');
	return noComments
		.split(';')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

beforeAll(async () => {
	const db = (env as unknown as { DB: D1Database }).DB;
	await applyD1Migrations(db, [
		{ name: '0001_initial_profiles', queries: splitSqlStatements(migration0001) },
		{ name: '0002_opening_positions', queries: splitSqlStatements(migration0002) },
	]);
});
