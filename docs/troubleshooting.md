# Troubleshooting

Start with `discordctl doctor --config <file>`; it checks most of the issues below.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `No Discord bot token configured` | No `DISCORD_TOKEN` and no stored login. | `discordctl login` or set `DISCORD_TOKEN` in `.env`. |
| `401 Unauthorized` | Token reset or mistyped. | Reset the token in the Developer Portal and log in again. |
| `Missing Permissions (50013)` | Bot lacks a permission, or the target role is at/above the bot's highest role. | `doctor`; grant the listed permissions; drag the bot's role higher. |
| `ROLE_ABOVE_BOT` | A managed role sits above the bot. | Server Settings → Roles → move the bot's role up. |
| `BOT_CANNOT_GRANT` / `BOT_CANNOT_OVERWRITE` | Discord only lets a bot grant permissions it holds. | Re-invite with `discordctl invite --config <file>` or add them to the bot's role. |
| `REQUIRES_COMMUNITY` | Announcement/stage/media channel on a non-Community server. | Enable Community or add `fallbackType`. |
| `AMBIGUOUS_MATCH` | Several existing resources share the configured name. | Pin one with `id: "<snowflake>"` (`inspect` shows IDs). |
| `TYPE_CHANGE_UNSUPPORTED` | Existing channel has an incompatible type. | Rename or delete it manually, or change the configured type. |
| `STATE_CHANGED` on apply | Someone changed the server after the plan was made. | Run `plan` again and review. |
| `Guild ... is locked` | Another apply is running, or one crashed. | Wait, or `discordctl state unlock --guild <id>`. |
| A plan keeps showing the same change | Discord normalized a value (e.g. name). | Use the form `apply` reports under "Verification", or open an issue. |
| `ORPHANED` warning | A previously managed resource was removed from the config. | Re-add it, `state rm` it, or `plan --allow-delete` to delete it. |
| Lost or corrupted state | `.discordctl/state.db` deleted. | `discordctl import --config <file>` re-adopts everything by name/ID. Back up with `state export`. |
| Apply partially failed | One operation failed; later ones were skipped. | Fix the cause and re-run `apply`: completed operations are in state and will not be repeated. |
| Rate limited for a long time | Discord asked to wait more than 60 s. | discordctl stops instead of sleeping; wait and re-run. |

Use `--verbose` to log every API request (tokens are always redacted).
