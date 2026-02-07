# Repository Guidelines

## Project Structure & Module Organization
`src/` contains all runtime code. Key areas:
- `src/main.ts`: Fastify/MCP server bootstrap.
- `src/mcp/`: MCP server and HTTP transport wiring.
- `src/router/`: message dispatch, queue processing, and Codex invocation.
- `src/db/`: SQLite access layer plus `schema.sql` and migrations.
- `src/agents/`: persona selection (`architect`, `oracle`).
- `src/integrations/`: optional external integrations (for example memorantado).
- `src/schemas/`: JSON output schemas copied into build artifacts.

`bin/tulayngmamamo.js` is the CLI entrypoint. `dist/` is generated output from TypeScript builds; do not edit it manually.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run dev`: run `src/main.ts` with `tsx` watch mode.
- `npm run typecheck`: run strict TypeScript checks without emitting files.
- `npm run build`: compile to `dist/` and copy SQL/JSON schema assets.
- `npm start`: run the compiled server from `dist/main.js`.

## Coding Style & Naming Conventions
- Language/tooling: TypeScript (ESM, `moduleResolution: NodeNext`, `strict: true`).
- Formatting in current codebase: 2-space indentation, semicolons, double quotes.
- Naming: `PascalCase` for classes/types, `camelCase` for variables/functions, `UPPER_SNAKE_CASE` for constants.
- Match local filename patterns in each folder (examples: `clientRegistry.ts`, `message_queue.ts`).
- Keep MCP and DB boundaries strongly typed; prefer explicit interfaces for inputs/outputs.

## Testing Guidelines
There is no dedicated automated test framework configured yet.
- Minimum pre-PR checks: `npm run typecheck` and `npm run build`.
- Manual smoke test:
  - Start server with `npm run dev`.
  - Verify health: `curl http://127.0.0.1:3790/health`.
  - Exercise at least one MCP tool path (for example `who_am_i` or `send_message`).
- If adding tests, colocate as `src/**/*.test.ts` and add a corresponding npm script in the same PR.

## Commit & Pull Request Guidelines
Current history uses short, imperative commit subjects (example: `add stdio`).
- Keep commit subjects concise and action-oriented.
- For non-trivial changes, include a body describing rationale and side effects.
- PRs should include: summary, impacted paths, verification steps/commands, related issue links, and notes for env or schema changes.

## Security & Configuration Tips
- Default local-only operation is intentional; avoid widening network exposure without review.
- Key env vars: `TULAYNGMAMAMO_PORT`, `TULAYNGMAMAMO_DB`, `MEMORANTADO_URL`.
- Do not commit local DB files, secrets, or machine-specific configuration.
