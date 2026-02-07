# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

tulayngmamamo is an MCP (Model Context Protocol) server that enables bidirectional communication between Claude Code CLI and OpenAI Codex CLI. It allows one AI assistant to delegate tasks (research, code review) to another and receive responses.

## Commands

```bash
npm run dev          # Run with tsx watch (hot reload)
npm run build        # Compile TypeScript and copy schema.sql to dist/
npm run start        # Run compiled output
npm run typecheck    # Type check without emitting
```

## Environment Variables

- `TULAYNGMAMAMO_PORT` - Server port (default: 3790)
- `TULAYNGMAMAMO_DB` - SQLite database path (default: ~/.tulayngmamamo/tulayngmamamo.sqlite)
- `MEMORANTADO_URL` - URL for memorantado integration (default: http://127.0.0.1:3789)
- `TULAYNGMAMAMO_CODEX_MODEL` - Default Codex model (default: gpt-5.3-codex)
- `TULAYNGMAMAMO_CODEX_REASONING_EFFORT` - Default reasoning effort (default: xhigh)

## Architecture

### Entry Points
- `src/main.ts` - Fastify server setup, registers MCP routes and health endpoint
- `bin/tulayngmamamo.js` - CLI entry point

### MCP Layer (`src/mcp/`)
- `server.ts` - MCP tool definitions (send_message, delegate_research, request_review, share_context, conversation management)
- `http.ts` - StreamableHTTPServerTransport setup, session management, client identity handling
- `eventStore.ts` - In-memory SSE event store for MCP streams
- `identity.ts` - Client identification from request headers

### Message Router (`src/router/`)
- `dispatcher.ts` - Queue-first message routing and conversation creation (fire-and-forget delivery)
- `invoker.ts` - Codex exec invocation utilities (fallback/integration path)

### Database Layer (`src/db/`)
- `db.ts` - SQLite connection with WAL mode, stores in ~/.tulayngmamamo/
- `schema.sql` - Tables: clients, conversations, messages, shared_context, message_queue, invocations
- `clients.ts`, `conversations.ts`, `messages.ts` - CRUD operations

### Integrations (`src/integrations/`)
- `memorantado.ts` - Optional integration to sync conversation summaries and research findings to memorantado

### Security (`src/security.ts`)
- Loopback-only access (127.0.0.1, ::1)
- Host header validation
- No Origin header allowed for /mcp endpoints

## Key Concepts

**Client Identity**: Two clients are supported: `claude` and `codex`. In HTTP mode, identity is determined from request headers via `identifyClient()`. In stdio mode, identity is resolved from `--client-id` / `TULAYNGMAMAMO_CLIENT_ID` (with parent-process auto-detection fallback).

**Message Flow**: Messages are stored in SQLite and enqueued in `message_queue`. Delivery is asynchronous: queue processor marks messages delivered when the target is online, and responses are retrieved via `get_response`/history tools.

**Conversations**: Multi-turn dialogues tracked with status (active/completed), optional project association, and summaries synced to memorantado on close.
