# discordctl

**Infrastructure as Code for Discord servers.** Describe roles, categories, channels, forums and permissions in YAML, preview changes with `plan`, apply them safely with `apply`, detect drift with `audit` — from the terminal or through an MCP server that AI coding agents (Claude Code, OpenCode, …) can use.

```text
$ discordctl plan --config examples/blastorama/discord.yaml

Plan for Blastorama (123456789012345678)

+ Create role: Moderator [medium risk]
+ Create role: Playtester
+ Create category: THE LAB
+ Create channel: 🐛╺╸bug-reports
~ Update channel: 📣╺╸announcements
    permissions[Moderator]: (none) → allow SendMessages, SendMessagesInThreads
↕ Move channel: 💬╺╸general
    category: (none) → COMMUNITY

Plan: 4 to create, 1 to update, 1 to move, 0 to delete.
```

> `discordctl` is a provisional name. It is defined in one place (`src/core/constants.ts` and the `bin` entries in `package.json`).

## Features

- **Declarative YAML** with Zod validation, line-numbered errors, presets, imports and templates — see [docs/configuration.md](docs/configuration.md).
- **Terraform-style plan/apply**: create, update, move, import and (only when explicitly allowed) delete, with dependency ordering and human-readable diffs.
- **Stable identity**: resources are tracked by logical key → Discord ID in a local SQLite state file. Renaming a channel in the config renames it in Discord; it is never recreated. Existing resources are adopted by name instead of duplicated.
- **Permission engine**: BigInt bitfields, category → channel inheritance, explicit allow/deny/inherit, effective-permission simulation, and an audit that flags dangerous setups (Administrator on members, exposed staff channels, writable announcements, locked-out moderators, conflicting overwrites, hierarchy inversions, failed `expect:` assertions).
- **Safe by default**: `apply` is a dry run unless confirmed, high-risk changes need extra confirmation, deletions need `--allow-delete` and only touch resources discordctl manages, stale plans are rejected, the last administrative role is protected, and bot tokens are redacted everywhere.
- **MCP server** for AI agents: read-only by default, plans are approval-bound with short expiry and a guild-state fingerprint check; there is no tool for arbitrary Discord API calls.
- **Multi-server**: every config, state entry, plan and lock is scoped to one guild; an optional allow-list limits which guilds can be touched.
- **Official API only**: bot authentication over Discord's REST API via `@discordjs/rest` (discord.js project), which handles rate-limit buckets from Discord's headers. No self-bots, user tokens, scraping or undocumented endpoints.

## Install

Requires Node.js ≥ 22.16 (LTS 24 recommended) and pnpm.

```bash
git clone https://github.com/paezao/discordctl && cd discordctl
pnpm install
pnpm build
pnpm link --global      # optional: puts `discordctl` and `discordctl-mcp` on your PATH
# or run without building: pnpm dev -- <command>
```

No Docker, database server or other infrastructure is needed. State lives in `./.discordctl/state.db` (SQLite via Node's built-in `node:sqlite`).

## Quick start

1. **Connect a bot** with the guided wizard (a few minutes):
   ```bash
   discordctl setup --config examples/blastorama/discord.yaml   # --config is optional
   ```
   It opens the Developer Portal, validates and stores the bot token (0600 file in `~/.config/discordctl`), opens an invite link requesting exactly the permissions the config needs, waits for the bot to join, saves `DISCORD_GUILD_ID` to `.env`, and re-runs `doctor` until the bot's role is positioned correctly. Manual alternative: [docs/bot-setup.md](docs/bot-setup.md), `cp .env.example .env`, `discordctl login`.
2. **Start from a template or from your existing server**:
   ```bash
   discordctl init --template gaming-community --output discord.yaml
   # or capture what you already have:
   discordctl export --guild $DISCORD_GUILD_ID --output discord.yaml --guild-var
   ```
3. **Check, preview, apply**:
   ```bash
   discordctl doctor   --config discord.yaml   # connectivity, permissions, hierarchy
   discordctl validate --config discord.yaml   # offline: schema + permission audit
   discordctl plan     --config discord.yaml
   discordctl apply    --config discord.yaml   # asks for confirmation
   discordctl apply    --config discord.yaml   # second run: "No changes."
   ```

## Commands

| Command | Purpose |
| --- | --- |
| `setup [--config F] [--guild G]` | Guided first-time setup: bot token, invite, role position, health checks. |
| `init [--template T] [--output F]` | Create a config from a template (`templates` lists them). |
| `login` / `logout` | Store/remove a bot token (hidden prompt or `--token-stdin`). Env vars take precedence. |
| `invite [--config F]` | OAuth2 URL requesting exactly the permissions a config needs. |
| `guilds` | Guilds the bot can access. |
| `inspect --guild G` | Roles, channel tree, overwrites, bot position. |
| `export --guild G [--output F]` | Current structure as YAML (round-trips to an empty plan). |
| `validate --config F [--strict]` | Offline validation, references, Discord limits, permission audit. |
| `plan --config F [--out plan.json] [--allow-delete] [--detailed-exitcode]` | Read-only preview. |
| `apply (--config F \| --plan plan.json \| --plan-id ID) [--yes] [--allow-high-risk] [--allow-delete] [--dry-run]` | Apply with confirmation, fingerprint check and post-apply verification. |
| `audit [--guild G] [--config F] [--fail-on high]` | Live permission audit plus drift detection. |
| `permissions [--config F \| --guild G] [--role R] [--channel C] [--list]` | Effective-permission matrix. |
| `import --config F [--dry-run]` | Adopt existing resources into state without changing Discord. |
| `doctor [--guild G] [--config F]` | Health checks. |
| `plans list/show`, `approve ID`, `reject ID` | Review plans proposed by AI agents. |
| `state list/rm/refresh/export/restore/reset/unlock` | Inspect and repair state. |
| `history` | Local audit log of applied changes. |
| `schema` | JSON Schema of the config format. |

Every command accepts `--json` for automation. Exit codes: `0` success, `1` error, `2` changes pending (`plan --detailed-exitcode`) or findings at/above `audit --fail-on`.

## Using it with AI agents (MCP)

```bash
claude mcp add discordctl -- node /absolute/path/to/discordctl/dist/mcp/main.js
```

The agent can inspect servers, export and edit configs, validate, audit and produce plans. Applying requires a human: either run `discordctl apply --plan-id <id>` yourself (read-only server, the default), or start the server with `--allow-apply` so the agent can call `discord_apply_plan` after you confirm in the client or with `discordctl approve <id>`. Details: [docs/mcp.md](docs/mcp.md).

## Example: Blastorama

[`examples/blastorama/discord.yaml`](examples/blastorama/discord.yaml) is a complete community server for a browser arena FPS: 6 roles in hierarchy, 5 categories, 14 channels named `emoji╺╸channel-name`, three tagged forums, read-only rules, staff-only announcements, developer-published dev updates, a hidden staff area, `expect:` assertions that `validate` checks, and suggested onboarding.

```bash
export DISCORD_GUILD_ID=<test server id>
discordctl permissions --config examples/blastorama/discord.yaml   # simulate access before applying
discordctl plan --config examples/blastorama/discord.yaml
```

On a server without the Community feature, the announcement channels are created as text channels (`fallbackType: text`) and converted in place once Community is enabled.

## Documentation

- [Bot creation, invitation and required permissions](docs/bot-setup.md)
- [Configuration reference](docs/configuration.md)
- [MCP server](docs/mcp.md)
- [Security model](docs/security.md)
- [Architecture](docs/architecture.md)
- [Discord limitations and manual steps](docs/limitations.md)
- [Troubleshooting](docs/troubleshooting.md)

## Development

```bash
pnpm install
pnpm dev -- plan --config examples/blastorama/discord.yaml   # run from source (tsx)
pnpm test           # unit + integration tests against an in-memory Discord fake
pnpm typecheck
pnpm build
```

Tests never touch Discord. `src/provider/fake.ts` emulates the behaviours discordctl relies on (role hierarchy, "can only grant what you have", name normalization, positions, Community-only types, forum tag IDs) and supports failure injection for rate limits and partial failures. An opt-in test against a real throwaway server lives in `tests/integration/` (see `.env.example`).

## License

MIT
