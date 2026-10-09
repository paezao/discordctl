# Discord limitations and manual steps

discordctl only automates what Discord's official bot API supports and what can be done safely and idempotently. Everything below is either a manual step, printed with step-by-step instructions by `plan`, `validate` and after a successful `apply`, or out of scope.

## Supported

| Resource | Managed fields |
| --- | --- |
| Server | name, description (Community), verification level, default notifications, explicit content filter, AFK timeout/channel, system channel, rules and public-updates channels (Community) |
| @everyone | guild-level permissions |
| Roles | name, color, hoist, mentionable, permissions, hierarchy order |
| Categories | name, order, permission overwrites |
| Text / announcement channels | name, category, order, topic, NSFW, slowmode (text), default thread slowmode and auto-archive, overwrites |
| Forum / media channels | the above plus guidelines, tags (name, emoji, moderated), require tag, default reaction, sort order, layout (forum) |
| Voice / stage channels | name, category, order, bitrate, user limit, region, video quality (voice), slowmode, overwrites |

## Manual steps (reported, not automated)

| Feature | Why | What to do |
| --- | --- | --- |
| **Enabling Community** | Changes server-wide policies and requires accepting Discord's guidelines. | Server Settings → Enable Community. Then re-run `plan`: channels with `fallbackType` are upgraded in place. |
| **Onboarding** (`onboarding:` block) | Requires Community and reshapes the new-member flow; discordctl v1 documents the suggested prompts instead of writing them. | `plan` and `apply` print click-by-click instructions: default channels, each question and its answers with roles and channels. |
| **Forum post templates** (`postTemplate:`) | No API field exists. discordctl does not post messages. | Create and pin a post; the template text is printed ready to copy. |
| **Server icon, banner, splash** | Binary assets; out of scope. | Server Settings → Overview. |

## Out of scope

- Assigning roles to members, kicking, banning, timeouts or any member management.
- Sending, editing or deleting messages; creating threads or forum posts.
- AutoMod rules, webhooks, integrations, emojis, stickers, soundboard, scheduled events, invites, welcome screen, role icons, gradient role colors, linked roles, role subscriptions.
- Converting channel types other than text ↔ announcement (Discord does not support it). discordctl reports an error instead of deleting and recreating the channel.

## Discord behaviours to know

- **Text-like channel names are normalized** by Discord: lowercase, spaces become dashes. discordctl compares normalized names so this never causes perpetual diffs, and `validate` tells you the stored form.
- **Announcement, stage and media channels require Community.** Use `fallbackType` to start without it. Forum channels are generally available; if Discord rejects one on your server, set `fallbackType: text` or enable Community.
- **Role hierarchy**: a bot can only edit roles below its highest role, and can only grant permissions it holds.
- **Channel ordering**: inside a category the Discord client always shows text-like channels before voice/stage channels, so discordctl orders them as two groups.
- **Overwrite permissions**: guild-only permissions (Administrator, Kick/Ban Members, Manage Server, Moderate Members, ...) cannot appear in channel overwrites; `validate` rejects them.
- **Limits** enforced by `validate`: 250 roles, 500 channels, 50 channels per category, 20 forum tags (20-character names), topic 1024 characters (4096 for forums), slowmode ≤ 6 hours, voice user limit ≤ 99.
