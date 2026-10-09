# Security model

discordctl changes who can see and do what on a Discord server, so safety is part of the architecture rather than a feature.

## Authentication and secrets

- **Bot tokens only.** `login` verifies the token belongs to a bot account and refuses user tokens. There is no self-bot mode, scraping, or use of undocumented endpoints.
- **Storage.** Tokens come from `DISCORDCTL_TOKEN` / `DISCORD_TOKEN` / `DISCORD_BOT_TOKEN`, or from `~/.config/discordctl/credentials.json`, written with mode `0600` (discordctl refuses to read it if group/other can). Tokens are never accepted as command-line arguments (they would end up in shell history); use the hidden prompt or `--token-stdin`.
- **Redaction.** Every token in use is registered with the redactor. Logs, error messages, JSON output and every MCP response are redacted, and token-shaped strings and `Authorization` headers are masked even if not registered.

## Least privilege

- `discordctl invite --config` computes the minimal permission set for a configuration.
- `doctor` warns when the bot holds Administrator but the configuration does not need it.
- The REST client only implements the 15 endpoints discordctl needs (`src/provider/api.ts`).

## Change safety

| Guard | Where |
| --- | --- |
| Plan/apply separation; `apply` is a dry run unless confirmed | CLI |
| High/critical-risk plans (granting Administrator/Manage Server/Manage Roles, exposing private channels, removing the last admin role, deletions) need `--allow-high-risk` with `--yes`, or typing the server name | CLI |
| Deletions need `--allow-delete` at plan *and* apply time, and only target resources discordctl previously managed. Unmanaged resources are never deleted. | planner, executor |
| Channel type changes that Discord cannot do in place are errors — never delete-and-recreate | planner |
| The last role granting administrative access cannot be removed without a critical-risk confirmation | planner |
| Plans whose guild fingerprint no longer matches are rejected (stale plans); a plan is atomically claimed before execution so it can run at most once | service, state |
| Every resource ID in a plan must belong to the target guild | executor |
| One apply per guild at a time (SQLite lock) | executor |
| Unmanaged overwrites (other bots, members) are preserved by default | planner |
| Integration-managed roles and @everyone cannot be targeted as roles | planner |
| Bounded retries; long rate limits fail instead of waiting; ambiguous creates are reconciled to avoid duplicates | executor, REST |
| Every operation is written to the local audit log and tagged in Discord's audit log as `discordctl apply <planId>` | executor |

## Permission audit

`validate`, `plan`, `audit` and `doctor` flag: Administrator or management permissions on @everyone or member roles, Administrator on staff roles (e.g. developers), private/staff channels visible to everyone, staff or moderators unable to see private/moderation channels, announcement channels writable by members, conflicting role overwrites, inverted role hierarchies, and failed `expect:` assertions.

## AI agents (MCP)

- Read-only by default; the only mutation tool (`discord_apply_plan`) takes nothing but a plan ID.
- Approval is out-of-band (CLI) or via the client's user-facing elicitation; high-risk plans require the CLI.
- Plans expire (default 15 minutes) and are bound to the guild state they were computed against.
- Config file access is sandboxed to a root directory; guilds can be restricted with `DISCORDCTL_ALLOWED_GUILDS`.
- Agents cannot reach Discord except through validated, planned operations.

## Reporting vulnerabilities

Please report security issues privately through [GitHub security advisories](https://github.com/paezao/discordctl/security/advisories/new) rather than in public issues.
