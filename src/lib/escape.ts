/**
 * Serialize a value as JSON that is safe to embed inside an HTML `<script>`
 * block.
 *
 * `JSON.stringify` does NOT escape `<`, `>`, `&`, or the JS line terminators
 * U+2028 / U+2029, so a string value containing `"</script>"` could break out
 * of the element and execute attacker-controlled markup (a classic XSS via
 * server-rendered JSON injection). Escaping these as `\uXXXX` keeps the
 * output valid JSON (`JSON.parse` decodes them back to the original
 * characters) while making the raw text inert as HTML.
 *
 * @param value - Any JSON-serializable value (or `undefined`, treated as `null`).
 * @returns A JSON string safe to inline inside `<script>...</script>`.
 */
export function jsonForScript(value: unknown): string {
	return JSON.stringify(value ?? null)
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}
