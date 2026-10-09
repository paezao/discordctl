# MCP server

`discordctl-mcp` exposes discordctl to MCP-compatible agents over stdio. The agent never receives the bot token and cannot call arbitrary Discord endpoints: every tool goes through the same validated plan/apply engine as the CLI.

## Setup (Claude Code)

```bash
pnpm build
claude mcp add discordctl -- node /absolute/path/to/discordctl/dist/mcp/main.js
```

or commit a project `.mcp.json` (see `examples/claude-code/.mcp.json`). The token comes from `DISCORD_TOKEN` in the environment or from `discordctl login`; never put it in `.mcp.json`.

Server flags / environment:

| Flag | Env | Default | Meaning |
| --- | --- | --- | --- |
| `--allow-apply` | `DISCORDCTL_MCP_ALLOW_APPLY=1` | off | Register `discord_apply_plan`. |
| `--approval cli` | `DISCORDCTL_MCP_APPROVAL` | `elicitation-or-cli` | `cli` always requires `discordctl approve`. |
| `--root DIR` | `DISCORDCTL_MCP_ROOT` | cwd | `configPath` and `imports` must stay inside this directory. |
| `--state PATH` | `DISCORDCTL_STATE` | `./.discordctl/state.db` | Share with the CLI so `approve` sees agent plans. |
| | `DISCORDCTL_ALLOWED_GUILDS` | all | Comma-separated guild allow-list. |
| | `DISCORDCTL_PLAN_TTL_SECONDS` | 900 | Plan lifetime (60–3600). |

## Tools

Read-only (annotated `readOnlyHint: true`):

| Tool | Input | Returns |
| --- | --- | --- |
| `discord_list_guilds` | – | guilds the bot can access |
| `discord_inspect_guild` | `guildId` | settings, bot capabilities, roles, channel tree with named overwrites |
| `discord_list_roles` / `discord_list_channels` | `guildId` | subsets of the above |
| `discord_get_permissions` | `guildId` or config, optional `roles`, `channels` | effective-permission matrix |
| `discord_export_config` | `guildId` | YAML of the current structure |
| `discord_validate_config` | `configYaml` or `configPath` | diagnostics, audit findings, manual steps (offline) |
| `discord_plan_changes` | config, optional `guildId`, `allowDelete` | `planId`, `expiresAt`, rendered `text`, operations, risks, findings, `nextStep` |
| `discord_get_plan_status` | `planId` | pending / approved / applied / rejected / expired |
| `discord_audit_permissions` | `guildId`, optional config | live findings and drift |
| `discord_check_bot_capabilities` | `guildId` and/or config | doctor checks |
| `discord_list_templates`, `discord_get_template`, `discord_get_config_schema` | – | authoring help |

Mutation (only with `--allow-apply`, annotated `destructiveHint: true`):

| Tool | Input |
| --- | --- |
| `discord_apply_plan` | `planId` only |

## Approval flow

1. The agent calls `discord_plan_changes`. The plan is stored with a short expiry, the config hash and a **fingerprint of the guild's current state**.
2. The user reviews the plan text.
3. Approval happens outside the agent's control:
   - **CLI**: the user runs `discordctl approve <planId>` (shows the plan, requires typing `yes`), or applies it directly with `discordctl apply --plan-id <planId>`.
   - **Elicitation**: if the MCP client supports elicitation, `discord_apply_plan` asks the user to confirm in the client UI. This is not available for high-risk or destructive plans, which always need the CLI.
4. `discord_apply_plan` re-fetches the guild and refuses if the fingerprint changed, the plan expired, or it was already applied/rejected. Plans cannot be replayed.

Without `--allow-apply` the server is read-only and `nextStep` tells the agent to hand the plan ID to the user.

## Suggested agent prompt

> Inspect guild 123…, export its config, add a #bug-reports forum under THE LAB with tags for Netcode/Graphics/Crash, validate it, and show me the plan.
