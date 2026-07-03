# Security Policy

## Project Status

Cloudflare Chess is a **reference/sample project** demonstrating an edge-native
application built on Cloudflare Workers. It is maintained on a best-effort
basis, not as a supported product — please keep that in mind when reporting
issues and set expectations accordingly.

## Supported Versions

There are no formal releases; only the `main` branch is maintained. Security
fixes, if any, will be applied to `main` only.

| Version | Supported |
|---------|-----------|
| `main`  | ✅ |

## Reporting a Vulnerability

Please report security vulnerabilities by opening a
[GitHub Security Advisory](../../security/advisories/new) on this repository
(preferred, keeps the report private until resolved), or by opening a regular
[GitHub Issue](../../issues) if the advisory feature is unavailable and the
issue is not sensitive.

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce, or a proof of concept
- Any suggested remediation, if you have one

## Response Timeline

As a best-effort project, we cannot guarantee response times, but we will
aim to acknowledge new reports within a reasonable timeframe and address
critical issues as promptly as possible.

## Disclosure Policy

Please practice coordinated disclosure: give us a reasonable opportunity to
investigate and address a report before any public disclosure.

## Scope Notes

This project intentionally ships with insecure defaults for **local
development only** (e.g. a placeholder `AUTH_SECRET`, disabled Turnstile/rate
limiting). These are documented in the [README](README.md#security-notes) and
are not vulnerabilities — they only apply when the corresponding production
secrets/bindings are left unconfigured. Reports about the dev-mode defaults
themselves are not actionable; reports about the underlying security
mechanisms (signed cookies, secret hashing, XSS escaping, etc.) are welcome.
