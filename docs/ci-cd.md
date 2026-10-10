# Managing a server from GitHub Actions

Keep `discord.yaml` in a repository and let pull requests drive changes, like Terraform with GitHub Actions. The ready-made workflow is [`examples/github-actions/discord.yml`](../examples/github-actions/discord.yml).

| Event | What happens |
| --- | --- |
| Pull request changing `discord.yaml` | Offline checks only: `validate --strict`, the permission audit and the simulated access matrix, posted (and updated) as a PR comment. No bot token is available to pull requests. |
| Merge to `main` | `plan` against Discord, shown on the run's summary page and saved as an artifact. |
| Approval in the `discord` environment | `apply` runs **exactly the saved plan**. If the server changed since it was planned, discordctl refuses (fingerprint check); re-run the workflow for a fresh plan. |
| Manual run (`workflow_dispatch`) | Same as a merge, with an optional `allow_delete` input. |

Nothing is deleted unless you run it manually with `allow_delete`.

## Setup

1. **Copy the workflow** to `.github/workflows/discord.yml` in the repository that holds `discord.yaml` (set `CONFIG` if the file lives elsewhere).
2. **Create two environments** (Settings → Environments → New environment). For **both**, set *Deployment branches and tags* to **Selected branches → `main`**:
   - `discord-plan`: no reviewers. Used to read the server for the plan.
   - `discord`: **Required reviewers** → add yourself (and enable *Prevent self-review* once there are several maintainers). This is the approval gate for apply.
3. **Bot token:** add `DISCORD_TOKEN` as an **environment secret** of both environments. Do **not** add it as a repository secret (see *Security*).
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

- **Why no token on pull requests:** a pull request runs the workflow file *from its own branch*, so anyone who can open one could edit the workflow to use any secret it can reach, for example to apply changes and skip approval. The token therefore lives only in environments limited to `main`, which pull-request runs cannot enter. Discord bot tokens cannot be made read-only, so there is no safe token to give pull requests.
- **Approval:** the `discord` environment's required reviewers are the human approval. The job applies with `--yes --allow-high-risk`, because the reviewer has seen the plan on the run summary before approving.
- **Who can change `main`:** whoever can push to `main` can change this workflow and therefore reach the token. Protect `main` (require pull requests and reviews) in repositories with several collaborators.
- **Public repositories:** plan comments and summaries show your server's role and channel names and permission layout. Use a private repository if that matters.
- **Pin the version:** `npx -y discordctl@0.1` stays on 0.1.x. Review release notes before raising it.
- **Concurrency:** one run at a time (`concurrency: discordctl`) so plans and applies never interleave; discordctl's own per-guild lock also guards apply.
