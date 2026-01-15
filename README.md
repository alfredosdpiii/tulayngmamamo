# tulayngmamamo

MCP server enabling bidirectional communication between Claude Code CLI and OpenAI Codex CLI. Allows AI assistants to delegate tasks (research, code review) to each other and receive responses.

## Features

- **AI-to-AI Communication**: Claude and Codex can send messages to each other
- **Agent Personas**: Architect (critical code review) and Oracle (debugging/root cause analysis) personas
- **Conversation Tracking**: SQLite-backed message history
- **Codex MCP Integration**: Spawns Codex as MCP server on-demand
- **memorantado Integration**: Sync conversation summaries to knowledge graph
- **Unlimited Connections**: Multiple Claude Code clients can connect simultaneously

## Installation

### From npm (recommended)

```bash
# Global install
npm install -g tulayngmamamo
tulayngmamamo

# Or run directly with npx
npx tulayngmamamo
```

### From source

```bash
git clone https://github.com/alfredosdpiii/tulayngmamamo.git
cd tulayngmamamo
npm install
npm run build
npm start
```

Server runs at `http://127.0.0.1:3790`

## MCP Configuration

Add to your `.mcp.json` or MCP client configuration:

### Option 1: HTTP Connection (recommended)

Start the server first (`tulayngmamamo` or `npx tulayngmamamo`), then configure your MCP client:

```json
{
  "mcpServers": {
    "tulayngmamamo": {
      "type": "http",
      "url": "http://localhost:3790/mcp"
    }
  }
}
```

### Option 2: Via npx (auto-starts server)

```json
{
  "mcpServers": {
    "tulayngmamamo": {
      "command": "npx",
      "args": ["tulayngmamamo"]
    }
  }
}
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `who_am_i` | Returns client identity (claude/codex) |
| `send_message` | Send message to another AI (supports `agent` parameter) |
| `delegate_research` | Request research on a topic |
| `request_review` | Request code/architecture review |
| `create_conversation` | Start a new conversation |
| `get_history` | Retrieve conversation messages |
| `share_context` | Share files/snippets between AIs |
| `list_conversations` | List active/completed conversations |
| `close_conversation` | Close and optionally summarize a conversation |

## Agent Personas

When sending messages to Codex, you can specify an agent persona:

| Agent | Use When | Behavior |
|-------|----------|----------|
| `architect` | Architecture questions, code review | Critical analysis, challenges assumptions, examines codebase |
| `oracle` | Debugging, "why" questions | Root cause analysis, strategic reasoning, action steps |

Auto-selected based on message content, or specify explicitly:

```
send_message(target="codex", content="Review this code", agent="architect")
send_message(target="codex", content="Why is this failing?", agent="oracle")
```

### Architect Persona

The Architect acts as a critical technical partner who:
- Examines the codebase independently before responding
- Agrees when you're right (but explains why)
- Disagrees when they see problems (with specific alternatives)
- Never just rubber-stamps suggestions

### Oracle Persona

The Oracle acts as a strategic advisor who:
- Focuses on root cause analysis
- Provides concrete action steps
- Helps understand "why" questions
- Uses strategic reasoning for complex problems

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `TULAYNGMAMAMO_PORT` | `3790` | Server port |
| `TULAYNGMAMAMO_DB` | `~/.tulayngmamamo/tulayngmamamo.sqlite` | Database path |
| `MEMORANTADO_URL` | `http://127.0.0.1:3789` | memorantado integration URL |

## Architecture

```
Claude Code CLI  <---->  tulayngmamamo  <---->  Codex CLI
       |                      |                    |
       |                      |                    |
    MCP Client           MCP Server          MCP Server
                        (this project)    (codex mcp-server)
```

### Message Flow

1. Client sends message via MCP tool
2. tulayngmamamo checks if target is online (in-memory registry)
3. If online: delivers to target's MCP session
4. If offline (Codex): spawns `codex mcp-server` or falls back to `codex exec`
5. Response stored in SQLite and returned to sender

## License

MIT
