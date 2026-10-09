# Architecture

```
            ┌────────────┐      ┌─────────────┐
            │  CLI       │      │  MCP server │      adapters (thin)
            │ src/cli    │      │  src/mcp    │
            └─────┬──────┘      └──────┬──────┘
                  └──────────┬─────────┘
                    DiscordctlService (src/service.ts)
     ┌──────────────┬────────┴───────┬───────────────┬──────────────┐
 Config engine   Planner          Executor       Permission engine   State
 src/config      src/plan         src/engine     src/permissions     src/state
 YAML→Zod→       desired vs       ordered ops,   bitfields, effective SQLite: key↔ID,
 DesiredState    snapshot → Plan  retries, locks perms, audit          plans, audit, locks
                         └────────────┬────────────┘
                         Discord provider (src/provider)
                         DiscordApi interface → REST (@discordjs/rest) | Fake (tests)
```

## Data flow

1. **Load** (`config/load.ts`): parse YAML with source positions, interpolate `${VAR}`, validate with Zod (strict), load preset imports.
2. **Resolve** (`config/resolve.ts`): apply presets, merge category → channel overwrites, expand `private`/`visibleTo`, resolve references, enforce Discord limits → `DesiredState` plus diagnostics.
3. **Snapshot** (`provider/normalize.ts`): fetch guild, roles, channels and the bot's member; normalize into `GuildSnapshot` (BigInt permissions, channel kinds, the bot's effective permissions and highest role).
4. **Plan** (`plan/planner.ts`):
   - *Match* each desired resource: pinned `id` → state mapping → unique name match (adoption). Stale mappings (deleted externally) are reported and recreated.
   - *Diff* only fields the config specifies. Overwrites are compared for managed targets; others are preserved (merge policy).
   - *Order* operations: role creates/updates → @everyone → role order → categories → channels → channel order → guild settings → deletions. References to resources created in the same plan are symbolic (`{ ref: "role:moderator" }`) and recorded as dependencies.
   - *Assess* risk per operation and bot capability (hierarchy, grantable permissions, Community features).
   - Produce a JSON-serializable `Plan` with a config hash and a guild-state fingerprint.
5. **Apply** (`service.ts` → `engine/executor.ts`): re-fetch and compare fingerprints, take the guild lock, execute operations serially, resolve references as resources are created, bind keys to IDs in state after each success, skip dependents of failed operations, audit-log everything, then re-plan to verify convergence.

## Design decisions

- **REST only, no gateway.** Configuration management needs no events or intents; the bot doesn't even need to be online.
- **`@discordjs/rest`** (from the discord.js project) provides Discord's per-route/global rate-limit handling from response headers. Full discord.js would add a gateway client discordctl does not need.
- **Narrow `DiscordApi` interface.** Exactly the endpoints the engine uses. It is the seam for the in-memory fake and guarantees adapters cannot make arbitrary calls.
- **Serial execution.** Discord rate limits make parallelism of little value, and order matters for hierarchy and positions; serial execution is deterministic.
- **State is a cache of identity, not of configuration.** Discord is the source of truth for current values; state only maps logical keys to IDs, so losing it is recoverable with `import`.
- **`node:sqlite`** avoids native build steps.
- **Omitted = unmanaged.** Makes adopting existing servers safe and incremental.
