# Configuration reference (version 1)

A configuration file describes **one** Discord server. Unknown keys are errors, so typos never pass silently. Run `discordctl schema` for the JSON Schema (useful for editor completion and AI agents).

```yaml
version: 1
metadata: { name: My Server, description: ..., tags: [...] }   # informational
imports: ["builtin:common", "./presets.yaml"]                    # preset libraries
guild: { id: "${DISCORD_GUILD_ID}" }
options: { manageRoleOrder: true, manageChannelOrder: true, overwritePolicy: merge }
everyone: { permissions: [...] }
roles: [...]
presets: { name: {...} }
categories: [...]
channels: [...]        # channels outside any category
onboarding: {...}      # printed as manual steps, or applied with manage: true
```

## Semantics

- **Omitted means unmanaged.** If a field is not in the config, discordctl leaves it as it is in Discord. Specified fields are authoritative.
- **Keys are identities.** `key` (lowercase, `a-z0-9-_`) is the stable logical name. Display names can change freely; discordctl renames instead of recreating. Keys are tracked in state against Discord IDs.
- **Adoption.** A key not yet in state is matched to an existing resource with the same name (and compatible type). Ambiguous matches are errors — pin with `id:`.
- **Order is hierarchy.** `roles` are listed highest first; categories and channels are listed in display order.
- **Nothing is deleted** unless it was previously managed, has been removed from the config, and `--allow-delete` is given.

## Environment variables

`${VAR}` and `${VAR:-default}` are replaced in every string. A missing variable without a default is an error. `$${` produces a literal `${`. `.env` in the working directory is loaded automatically (`--env-file` to choose another).

## guild

| Field | Notes |
| --- | --- |
| `id` | Required. Guild ID. `--guild` may supply it but cannot contradict it. |
| `name`, `description` | Description requires Community. |
| `verificationLevel` | `none` `low` `medium` `high` `very_high` |
| `defaultNotifications` | `all_messages` `only_mentions` |
| `explicitContentFilter` | `disabled` `members_without_roles` `all_members` |
| `afkTimeout`, `afkChannel` | seconds (60/300/900/1800/3600), voice channel key |
| `systemChannel`, `rulesChannel`, `publicUpdatesChannel` | channel keys; the last two require Community |

## options

| Option | Default | Meaning |
| --- | --- | --- |
| `manageRoleOrder` | `true` | Reorder managed roles to match the list (within the slots they occupy). |
| `manageChannelOrder` | `true` | Reorder managed categories/channels to match the list. |
| `overwritePolicy` | `merge` | `merge`: keep overwrites for roles/members not in the config (e.g. other bots). `authoritative`: remove them. Overridable per channel. |

## everyone / roles

```yaml
everyone:
  permissions: [ViewChannel, SendMessages, ReadMessageHistory, Connect, Speak]

roles:
  - key: moderator
    name: Moderator
    tier: staff              # admin | staff | member | bot (inferred if omitted); used by the audit
    color: "#2ecc71"
    hoist: true
    mentionable: false
    permissions: [ManageMessages, ModerateMembers, KickMembers]
    id: "123..."             # optional: pin to an existing role
```

`permissions` is the complete list for that role. Omit it to leave the role's permissions unmanaged; use `[]` for none. Names are Discord's (`ViewChannel`) or aliases (`view`, `send`, `history`, `react`, `connect`, `timeout`, …) in any case style — `discordctl permissions --list` shows all.

Integration roles (bot roles, booster role) and `@everyone` cannot be listed as roles.

## categories and channels

```yaml
categories:
  - key: staff
    name: "🛡️ STAFF"
    private: true                     # deny ViewChannel to @everyone + audit marker
    visibleTo: [admin, moderator]     # allow ViewChannel for these roles
    permissions:                      # explicit overwrites
      moderator: { ManageMessages: allow }
    channels:
      - key: mod-log
        name: mod-log
        type: text                    # text | announcement | forum | media | voice | stage
        topic: Moderation log
        slowmode: 10s                 # seconds or "30s", "5m", "1h"
        permissions:
          moderator: { send: deny }
```

### Permission overwrites

```yaml
permissions:
  <target>:
    <permission>: allow | deny | inherit     # also true / false / null
```

Targets: `everyone`, a role key (or `role:<key>`), `roleId:<snowflake>` for a role not in the config, `member:<snowflake>`.

**Inheritance.** A channel's effective overwrites are the category's overwrites with the channel's own entries applied on top, per target and per permission. `inherit` removes a value inherited from the category. With no channel `permissions`, the channel is exactly synced with its category. Set `inheritPermissions: false` to ignore the category entirely.

A channel's overwrites are managed when it or its category declares `permissions`, `private` or `visibleTo`. Otherwise they are left untouched.

### Channel fields by type

| Field | Types |
| --- | --- |
| `topic` | text, announcement, forum, media |
| `guidelines` | forum, media (alias for topic: the post guidelines) |
| `nsfw` | all |
| `slowmode` | text, forum, media, voice, stage |
| `tags` `[{ name, emoji, moderated }]` | forum, media (max 20; `moderated` tags can only be applied by members with Manage Threads) |
| `tagPolicy` | `merge` (default, keeps tags not in the config) or `authoritative` |
| `requireTag`, `defaultReaction`, `sortOrder` (`latest_activity`/`creation_date`) | forum, media |
| `layout` (`default`/`list`/`gallery`) | forum |
| `defaultThreadSlowmode`, `defaultAutoArchive` (`1h`/`24h`/`3d`/`1w`) | text, announcement, forum, media |
| `bitrate`, `userLimit`, `rtcRegion` | voice, stage |
| `videoQuality` (`auto`/`full`) | voice |
| `fallbackType` | announcement→text, stage→voice, media→forum/text, forum→text; used when the server lacks Community |
| `postTemplate` | forum, media; advisory, printed as a manual step |

### expect: permission assertions

Declare who must or must not have access; `validate`, `plan` and `audit` report violations as high-severity findings.

```yaml
expect:
  view: [moderator, admin]
  noView: [everyone, playtester]
  send: [admin]
  noSend: [everyone]
  connect: [...]
  noConnect: [...]
```

Each entry simulates a member holding `@everyone` plus that role.

## onboarding

```yaml
onboarding:
  manage: true             # apply through the API; false (default) = print click-by-click steps instead
  enabled: true            # omit to keep the server's current setting
  mode: default            # default | advanced (omit to keep)
  defaultChannels: [rules, announcements, general, looking-for-game, game-discussion, clips, memes]
  prompts:
    - title: What do you want to hear about?
      type: multiple_choice  # or dropdown
      singleSelect: false
      required: false
      inOnboarding: true     # false = only under Channels & Roles
      options:
        - { title: Game nights, emoji: "🏆", description: Weekly tournaments, roles: [event-ping], channels: [looking-for-game] }
```

With `manage: true`:

- Requires the **Community** feature and gives the bot's required permissions **Manage Server** (plus Manage Roles).
- Questions and answers are matched to the live ones **by title**, so Discord keeps their IDs. Renaming a title replaces that question or answer.
- The config is **authoritative for questions**: Discord replaces all prompts on every update, so live questions missing from the config are removed. The plan lists each one as a medium-risk change.
- Turning onboarding **off** is high risk, turning it on medium. Leave `enabled` unset to never change it.
- Discord's rule for enabled onboarding in default mode (at least 7 default channels, 5 of them postable by @everyone) is checked against the permissions the plan will produce, before anything is sent.
- `export` includes the live onboarding with `manage: true`, so you can start from what members see today.

## presets and imports

Presets are partial channel definitions. A channel or category can apply one or several (`preset: [a, b]`); later presets override earlier ones and the channel's own fields override all presets. `permissions` merge per target and permission; `visibleTo` lists are combined.

```yaml
imports: ["builtin:common"]       # templates/presets/common.yaml
presets:
  lab-forum: { type: forum, requireTag: true, defaultReaction: "👍" }
```

Built-in presets: `read-only`, `announcements`, `public-chat`, `public-forum`, `showcase-forum`, `staff-only`, `public-voice`. A preset library file has `version: 1` and a `presets:` map.

## Templates

`discordctl templates` lists the built-in layouts (`gaming-community`, `open-source-project`, `saas-community`, `creator-community`, `small-private-team`). They are ordinary config files under `templates/`; `init` copies one for you to edit.
