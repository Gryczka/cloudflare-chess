import { describe, expect, it } from 'vitest';
import { jsonForScript } from '../../src/lib/escape';
import { safeUsername } from '../../src/lib/identity';

describe('jsonForScript (QR-2 XSS)', () => {
	it('escapes a </script> breakout in string values', () => {
		const payload = jsonForScript({ username: '</script><script>alert(1)</script>' });
		expect(payload).not.toContain('</script>');
		expect(payload).not.toContain('<script>');
		expect(payload).toContain('\\u003c');
		// Still valid JSON that round-trips back to the original value.
		expect(JSON.parse(payload).username).toBe('</script><script>alert(1)</script>');
	});

	it('escapes ampersands and JS line terminators', () => {
		const payload = jsonForScript({ a: 'x&y', b: 'line\u2028sep\u2029' });
		expect(payload).not.toMatch(/[&<>\u2028\u2029]/);
		expect(JSON.parse(payload)).toEqual({ a: 'x&y', b: 'line\u2028sep\u2029' });
	});
});

describe('safeUsername (QR-2 sanitization)', () => {
	it('strips HTML/JS-dangerous characters', () => {
		expect(safeUsername('</script><b>')).not.toMatch(/[<>&"'`\\]/);
	});

	it('collapses whitespace and caps length at 24', () => {
		expect(safeUsername('  Ada   Lovelace  ')).toBe('Ada Lovelace');
		expect(safeUsername('x'.repeat(50)).length).toBe(24);
	});

	it('falls back to a generated name when empty', () => {
		expect(safeUsername('   ')).toMatch(/^Player \d{4}$/);
		expect(safeUsername(null)).toMatch(/^Player \d{4}$/);
	});
});
