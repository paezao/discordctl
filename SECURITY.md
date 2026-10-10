# Security policy

discordctl changes who can see and do what on Discord servers, so we take security reports seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through
[GitHub private vulnerability reporting](https://github.com/paezao/discordctl/security/advisories/new).

Include the affected version, steps to reproduce and the impact you expect. You should get an acknowledgement within a few days. Fixes are released as patch versions and announced in a GitHub security advisory.

## Supported versions

Only the latest released version receives security fixes while the project is in `0.x`.

## Scope

Examples of issues we want to hear about:

- Bot token disclosure (logs, errors, MCP responses, state files)
- Ways for an MCP client or agent to apply changes without human approval, replay or apply stale plans, or reach Discord endpoints outside the planned operations
- Changes applied to resources or guilds outside the configuration's guild
- Deletion of resources discordctl does not manage
- Reading files outside the MCP sandbox root

The security model is described in [docs/security.md](docs/security.md).
