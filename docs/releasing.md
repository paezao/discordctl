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
4. publishes to npm (`latest`, or `next` for versions like `0.2.0-beta.1`),
5. creates a GitHub Release with generated notes and the `.tgz` attached.

While the configuration format may still change, stay on `0.x`: bump the minor version for breaking or notable changes and the patch version for fixes.

## One-time setup

1. **npm account** with two-factor authentication: https://www.npmjs.com/signup
2. **First publish.** npm can only attach a trusted publisher to a package that already exists, so the first release needs a token:
   - npmjs.com → Access Tokens → Generate New Token → *Granular*, with read and write access to packages; restrict it to `discordctl` if offered, and give it a short expiry.
   - GitHub repo → Settings → Secrets and variables → Actions → New secret `NPM_TOKEN`.
   - Push the `v0.1.0` tag (`git tag v0.1.0 && git push origin v0.1.0`).
3. **Switch to trusted publishing** (no long-lived secret):
   - npmjs.com → the `discordctl` package → Settings → Trusted Publisher → GitHub Actions: owner `paezao`, repository `discordctl`, workflow `release.yml`, environment `npm`.
   - Delete the `NPM_TOKEN` secret and revoke the token on npm.
   - Optionally require trusted publishing only: package Settings → Publishing access → disallow tokens.

Once the repository is public, trusted publishing also attaches provenance, so npm shows which commit and workflow built each version.

## Checking a release locally

```bash
npm pack                          # runs the build via `prepack`
npm install -g ./discordctl-*.tgz
discordctl --version
```
