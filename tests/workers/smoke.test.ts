import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('workers harness', () => {
	it('exposes Durable Object bindings inside workerd', () => {
		expect(env.CHESS_MATCH).toBeDefined();
		expect(env.MATCHMAKER).toBeDefined();
	});
});
