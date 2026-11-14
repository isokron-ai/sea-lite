# Releasing sea-lite

Releases are published by `.github/workflows/release.yml` with **npm trusted publishing**
(OpenID Connect, no npm token) and an npm **provenance** attestation, so every published version
traces back to a tagged commit of this repository. Nobody publishes from a laptop.

## One-time setup (owner, in the GitHub and npm web UIs)

These need the package owner's npm account and repository admin rights; the workflow cannot do
them. Do them in this order.

1. **GitHub environment.** Repository → Settings → Environments → New environment
   `npm-publish`.
   - Required reviewers: the owner (a pushed tag waits for an approval before it publishes).
   - Deployment branches and tags: "Selected branches and tags", add the tag rule `v*.*.*`.
   - Add no secrets to it.
2. **Protect the tags.** Repository → Settings → Rules → Rulesets → New ruleset → New tag
   ruleset: name `release tags`, enforcement Active, target tags matching `v*.*.*`, rules
   "Restrict creations", "Restrict updates" and "Restrict deletions", bypass list: Repository
   admin (the owner).
3. **npm trusted publisher.** npmjs.com → package `sea-lite` → Settings → Trusted Publisher →
   GitHub Actions:

   | Field | Value |
   | --- | --- |
   | Organization or user | `isokron-ai` |
   | Repository | `sea-lite` |
   | Workflow filename | `release.yml` |
   | Environment name | `npm-publish` |
   | Allowed actions | tick **`npm publish`** (direct publish); leave "Allow npm dist-tag" off |

   Trusted publishers created after 3 Sep 2026 allow only `npm stage publish` unless direct
   `npm publish` is ticked, and this workflow publishes directly.

   All fields are case-sensitive, and npm checks them only at publish time. **A new trusted
   publisher expires if it has not published within 2 days**, so add it when the first release
   is ready to tag, not earlier. An expired one has to be deleted and added again.
4. **After the first release from the workflow succeeds** (and only then): npmjs.com → package
   → Settings → Publishing access → "Require two-factor authentication and disallow tokens" →
   Update Package Settings, and revoke any npm tokens used for earlier releases (npmjs.com →
   Access Tokens). The trusted publisher keeps working; tokens no longer can.

A dry run needs none of the above: Actions → release → Run workflow builds, tests and packs on
the chosen branch and prints the tarball's integrity in the job summary. A manual run never
publishes; only a pushed `vX.Y.Z` tag does.

## Each release

1. On a branch, set the version everywhere `test/version.test.ts` checks (package.json, the
   lockfile, server.json, `CATALOG_VERSION` in `src/catalog.ts`, `.mcp-catalog/sea-lite.json`),
   date the CHANGELOG entry (`## [X.Y.Z] — YYYY-MM-DD`; earlier releases left the heading as
   "Unreleased", the release workflow now refuses that), and merge the PR with CI green.
2. Tag the merge commit and push the tag:
   ```sh
   git tag -s vX.Y.Z -m "sea-lite X.Y.Z"   # or -a if you do not sign tags
   git push origin vX.Y.Z
   ```
3. The workflow runs:
   - `verify` (no token): the tag names package.json's version and its commit is on `main`, the
     CHANGELOG entry is dated,
     package.json's `repository.url` names this repository; then lint, typecheck, the test suite and the catalog check; then `npm pack`
     of the tested build, its sha512 integrity, `npm publish --dry-run`, and the tarball handed
     on as an artifact. Dependency install scripts run only in this job;
   - `publish` (waits for the `npm-publish` approval; holds the OIDC token): npm 11.5.1+ on
     Node 22.14.0+, the tag check again, a check that the downloaded tarball has the integrity
     `verify` recorded, `npm publish <tarball> --provenance --access public --ignore-scripts`, then a check that
     the registry serves the same integrity with a provenance attestation. It installs no
     project dependencies.
4. Approve the `npm-publish` deployment when `verify` is green.

## After a release

```sh
npm view sea-lite@X.Y.Z dist.integrity dist.attestations
```

The npm package page shows "Built and signed on GitHub Actions" with links to the workflow run
and the commit.

## If the publish step fails

- `E404` / `E403` / `ENEEDAUTH` ("Unable to authenticate") on publish: the trusted publisher on
  npmjs.com does not match this workflow (organization, repository, workflow filename and
  environment must all match exactly), "Allowed actions" does not include direct `npm publish`,
  or the trusted publisher expired before its first publish.
- The registry check fails after the publish step succeeded: the registry was slow. Check by
  hand with `npm view sea-lite@X.Y.Z dist.integrity dist.attestations`; do not re-run the publish
  (a version cannot be published twice).
- `E422 … repository.url`: package.json `repository.url` does not name
  `github.com/isokron-ai/sea-lite`.
- `npm 10.x cannot publish with trusted publishing`: the npm upgrade step did not run.

The workflow also refuses a tag whose commit is not on `main`.

Do not add an `NPM_TOKEN` secret to make a failing publish pass: a token bypasses trusted
publishing and drops the provenance guarantee.
