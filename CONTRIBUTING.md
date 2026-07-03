# Contributing to Cloudflare Chess

Thanks for your interest in contributing! This is a reference/sample project demonstrating an edge-native application built on Cloudflare Workers, maintained on a best-effort basis. Contributions, bug reports, and ideas are all welcome.

## How to Contribute

1. Fork the repository.
2. Create a feature branch off `main`: `git checkout -b my-change`.
3. Make your changes, following the code style below.
4. Run the full check gate (see [Development Setup](#development-setup)) and make sure it passes.
5. Commit with a clear message and open a pull request against `main`.

## Development Setup

```bash
git clone https://github.com/<your-fork>/cloudflare-chess.git
cd cloudflare-chess
npm install
npm run dev        # wrangler types && astro dev — http://localhost:8788
```

Run the tests and type-check before opening a PR:

```bash
npm run check        # astro check + unit tests + workers tests — the full CI gate
npm run test:unit     # Node/vitest unit tests
npm run test:workers  # workerd/vitest Durable Object integration tests
```

`npm run build` (which also regenerates Wrangler's runtime types) should complete without errors.

## Code Style

- TypeScript throughout; keep new code strictly typed (avoid `any` where practical).
- Match the existing tab-indentation and formatting conventions already used in the file you're editing.
- Favor small, focused Durable Object methods over large branching handlers — see `src/lib/durable-objects/chess-match.ts` for the existing pattern (single `applyMove()` path shared by human/bot moves).
- Add JSDoc to new exported functions/classes, especially anything touching identity, ratings, or Durable Object storage.

## Commit Messages

Write clear, present-tense commit messages describing *what* changed and, if not obvious, *why*. Conventional Commits prefixes (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`) are welcome but not required.

## Pull Request Process

- Keep PRs focused on a single change where possible.
- Make sure `npm run check` passes locally — CI runs the same gate plus `npm run build`.
- Describe what you tested and how, especially for anything touching Durable Object state, session/identity code, or D1 migrations (migrations must be additive — see the note in `migrations/`).
- Be patient — this project doesn't have a dedicated maintenance team, so review may take a while.

## Bug Reports

Please use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) and include steps to reproduce, expected vs. actual behavior, and relevant environment details.

## Feature Requests

Please use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md) and describe the problem you're trying to solve, not just the solution.

## Code of Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.
