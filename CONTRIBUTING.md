# Contributing

Thanks for helping improve discordctl.

## Development setup

Requires Node.js ≥ 22.16 and pnpm.

```bash
git clone https://github.com/paezao/discordctl && cd discordctl
pnpm install
pnpm check                # typecheck + tests
pnpm dev -- --help        # run the CLI from source
```

Tests run against an in-memory Discord emulation (`src/provider/fake.ts`) and never contact Discord. When you find a real Discord behaviour the fake gets wrong, teach the fake first, add a failing test, then fix the code.

The optional real-Discord integration test (`tests/integration/`) needs a throwaway server; see `.env.example`.

## Guidelines

- **Safety first.** Changes must keep the guarantees in [docs/security.md](docs/security.md): no silent deletions, plan/apply separation, approval-bound MCP mutations, no token exposure.
- **Official API only.** No self-bots, user tokens, scraping or undocumented endpoints.
- **Idempotency.** Applying the same configuration twice must produce no changes. Add a test that plans again after applying.
- Keep the CLI usable without AI: the MCP server is an optional adapter over the same service.
- Document configuration changes in `docs/configuration.md` and Discord limitations in `docs/limitations.md`.

## Pull requests

1. Fork and create a branch.
2. Make your change with tests; `pnpm check` must pass.
3. Describe the motivation and any behaviour change in the PR.

Releases are cut by maintainers; see [docs/releasing.md](docs/releasing.md).

## License

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
