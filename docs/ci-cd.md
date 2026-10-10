# Managing a server from GitHub Actions

Keep `discord.yaml` in a repository and let pull requests drive changes, like Terraform with GitHub Actions. The ready-made workflow is [`examples/github-actions/discord.yml`](../examples/github-actions/discord.yml).

| Event | What happens |
| --- | --- |
| Pull request changing `discord.yaml` | `validate --strict`, then `plan`; the plan is posted (and updated) as a PR comment. |
| Merge to `main` | `plan` again, shown on the run's summary page and saved as an artifact. |
| Approval in the `discord` environment | `apply` runs **exactly the saved plan**. If the server changed since it was planned, discordctl refuses (fingerprint check); re-run the workflow for a fresh plan. |
| Manual run (`workflow_dispatch`) | Same as a merge, with an optional `allow_delete` input. |

Nothing is deleted unless you run it manually with `allow_delete`.

## Setup

1. **Copy the workflow** to `.github/workflows/discord.yml` in the repository that holds `discord.yaml` (set `CONFIG` if the file lives elsewhere).
2. **Create the approval gate:** Settings → Environments → **New environment** `discord` → **Required reviewers** → add yourself. Optionally restrict it to the `main` branch.
3. **Bot token:**
   - Add `DISCORD_TOKEN` as a secret of the `discord` environment (used by apply).
   - For plans on pull requests, also add it as a **repository** secret. Plans are read-only, but the token itself can write, see *Security* below.
4. **Guild:** Settings → Secrets and variables → Actions → **Variables** → `DISCORD_GUILD_ID`. The workflow also sets `DISCORDCTL_ALLOWED_GUILDS` to it, so a config edited to target another server is refused.
5. In `discord.yaml`, use `guild: { id: "${DISCORD_GUILD_ID}" }`.

The bot needs the same permissions and role position as for local use; run `discordctl doctor --config discord.yaml` locally once.

## State

discordctl's state maps config keys to Discord IDs. In CI it is kept as `state.json` on a separate branch, `discordctl-state`:

- each job restores it before planning, and the apply job writes it back afterwards (only when it changed);
- the branch never touches `main`, so branch protection is unaffected;
- it contains only keys, Discord IDs and names, no secrets.

If the branch is lost, discordctl recovers by matching resources by name on the next plan (they show up as `import`). Pin `id:` in the config for anything with a duplicate name.

To seed it from an existing local setup: `discordctl state export > state.json`, then commit that file alone on an orphan `discordctl-state` branch.

## Security

- **Approval:** the `discord` environment's required reviewers are the human approval. The job applies with `--yes --allow-high-risk`, because the reviewer has seen the plan on the run summary before approving.
- **Pull requests from forks** never receive secrets; the plan job is skipped for them. Pull requests from branches of the same repository run with the token, so only give write access to people you would trust with the bot.
- **Public repositories:** plan comments and summaries show your server's role and channel names and permission layout. Use a private repository if that matters.
- **Pin the version:** `npx -y discordctl@0.1` stays on 0.1.x. Review release notes before raising it.
- **Concurrency:** one run at a time (`concurrency: discordctl`) so plans and applies never interleave; discordctl's own per-guild lock also guards apply.
