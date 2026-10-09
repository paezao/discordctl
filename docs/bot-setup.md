# Bot setup

discordctl acts through a Discord **bot** you create and control. It never uses user accounts, user tokens or passwords.

**Fastest path:** `discordctl setup [--config discord.yaml]` walks through every step below, opens the right pages, validates the token, waits for the bot to join your server and checks its permissions and role position. Discord has no API for creating applications or approving invites, so you still click through those two pages yourself; the wizard does the rest.

Options: `--guild <id>` preselects the server, `--no-browser` only prints links, `--no-wait` skips waiting for the invite, `--timeout <seconds>` (default 300), `--env-out <file>` (default `.env`; only the guild ID is written there, never the token).

The manual steps:

## 1. Create the application and bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**. Name it (e.g. "MyServer Config").
2. Open **Bot**:
   - Click **Reset Token** and copy the token. Treat it like a password.
   - Turn **off** "Public Bot" so only you can add it to servers.
   - Leave all **Privileged Gateway Intents** off. discordctl uses the REST API only and never connects to the gateway, so it needs no intents.
3. Store the token: `discordctl login` (saved with mode 600 under `~/.config/discordctl/`) or `DISCORD_TOKEN` in `.env`.

## 2. Invite the bot with least privilege

```bash
discordctl invite --config discord.yaml
```

prints an OAuth2 URL (scope `bot`) that requests exactly what the configuration needs:

| Permission | Why |
| --- | --- |
| View Channels | Read the channel structure. |
| Manage Roles | Create/edit roles and channel permission overwrites. |
| Manage Channels | Create/edit/move channels and categories. |
| Manage Server | Only if the config sets `guild:` settings (name, system channel, ...). |
| Every permission the config grants | Discord only lets a bot grant (or allow/deny in an overwrite) permissions it holds itself. |

If your config grants `Administrator` to a role, the bot needs `Administrator` too. The Blastorama example deliberately avoids that.

Without a config, `discordctl invite` requests the base set (View Channels, Manage Roles, Manage Channels).

## 3. Put the bot's role above the roles it manages

Discord only lets a bot edit roles **below its own highest role**. After inviting:

Server Settings → Roles → drag the bot's role (named after the application) **above** every role in your config.

`discordctl doctor --config discord.yaml` checks this, together with connectivity, guild access, missing permissions and Community features.

## 4. Find your guild ID

Discord → User Settings → Advanced → **Developer Mode** on. Right-click the server icon → **Copy Server ID**. Put it in `.env` as `DISCORD_GUILD_ID` or pass `--guild`.

## Multiple servers

One bot can be in many servers. Each config targets exactly one guild, and state, plans and locks are kept per guild. To prevent accidents, restrict which guilds discordctl will touch:

```bash
DISCORDCTL_ALLOWED_GUILDS=111111111111111111,222222222222222222
```
