# Releasing

Releases are published to npm and GitHub by `.github/workflows/release.yml` when a `v*` tag is pushed.

## Every release

```bash
git checkout main && git pull
npm version minor          # or patch / major / prerelease --preid beta; commits and tags vX.Y.Z
git push --follow-tags
```

The workflow then:

1. checks the tag matches `package.json`,
2. runs typecheck and tests,
3. packs the package and smoke-tests the installed tarball,
4. **stages** the release on npm (`latest`, or `next` for versions like `0.2.0-beta.1`),
5. creates a GitHub Release with generated notes and the `.tgz` attached.

**Then approve it.** Staged versions are not installable until a maintainer approves them with 2FA:

- npmjs.com → **discordctl** → **Staged Packages** → **Approve**, or
- `npm stage list discordctl`, then `npm stage approve <stage-id>` (npm ≥ 11.15).

The workflow run's summary page repeats these steps.

While the configuration format may still change, stay on `0.x`: bump the minor version for breaking or notable changes and the patch version for fixes.

## One-time setup (done)

1. npm account with two-factor authentication.
2. First publish (v0.1.0) with a short-lived granular token stored as the `NPM_TOKEN` secret, because npm can only attach a trusted publisher to an existing package.
3. Trusted publisher on npmjs.com → discordctl → Settings → Trusted Publisher → GitHub Actions: owner `paezao`, repository `discordctl`, workflow `release.yml`, environment `npm`. **Allowed actions: leave `npm publish` and `npm dist-tag` unchecked**, so CI can only stage releases.
4. Revoke the token on npm and delete the `NPM_TOKEN` secret.

Once the repository is public, trusted publishing also attaches provenance, so npm shows which commit and workflow built each version.

## Checking a release locally

```bash
npm pack                          # runs the build via `prepack`
npm install -g ./discordctl-*.tgz
discordctl --version
```
