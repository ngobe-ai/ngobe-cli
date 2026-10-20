# CI and releases

## What runs when

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | push to `main`, every pull request, and before each release | Typecheck, `bun test`, build, Node smoke test (Ubuntu and macOS); `npm pack` installed globally on Node 22 and 24; a Linux binary built, smoke-tested and installed through `install.sh` from a local mirror; ShellCheck on `install.sh` |
| `release.yml` | pushing a tag `v*` | Checks the tag matches `package.json`, runs CI, builds each binary on its own platform, runs it and verifies its signature, creates the GitHub Release (archives, `SHA256SUMS`, `install.sh`), runs `publish.yml`, then installs the release with `curl … \| sh` on Ubuntu and macOS |
| `publish.yml` | called by the release, or by hand: `gh workflow run publish.yml -f version=0.2.0` | Publishes an existing release to npm (with provenance) and updates `Formula/ngobe.rb` in `ngobe-ai/homebrew-tap`. Skips whatever is already published, so it's safe to re-run, e.g. after adding a secret |
| `live.yml` | daily, or by hand | The live tests against the official version, release-note and advisory endpoints, which can change format without notice |

Dependabot opens weekly PRs for GitHub Actions and npm dependencies.

Bun does all building and testing. The npm CLI appears only where the npm registry is involved: the CI job that installs the packed tarball the way an npm user would, and `npm publish --provenance` in the release (`bun publish` has no provenance option; provenance signs a link from the package to the workflow run that built it).

## One-time setup

1. **Make `ngobe-ai/ngobe-cli` public** (done 2026-10-19). Release files, `raw.githubusercontent.com/…/install.sh` and npm provenance all need it.
2. **npm:** the package is `@ngobe-ai/ngobe` (npm refused the plain name `ngobe` as too similar to `node`; scoped names aren't checked for that). It needs the npm organization `ngobe-ai` (npmjs.com → Add Organization → free plan for public packages) with your account as a member. Log in (`npm login`), then on npmjs.com → Access Tokens → Generate New Token → Granular: "Read and write" for packages and scopes, including the `@ngobe-ai` scope, and allow it to bypass two-factor authentication so CI can publish. Store it: `gh secret set NPM_TOKEN --repo ngobe-ai/ngobe-cli` (paste when asked). Without it, publishing skips npm with a warning. Write tokens expire (90 days at most), so renew it, or after the first publish switch to npm trusted publishing (OIDC, no token).
3. **Homebrew:** the public tap `ngobe-ai/homebrew-tap` exists (created 2026-10-19). The `ngobe-ai` organisation has deploy keys turned off, so the workflow pushes with a token: on GitHub → Settings → Developer settings → Fine-grained tokens → resource owner `ngobe-ai`, repository access "Only select repositories: homebrew-tap", permission Contents: Read and write. Store it: `gh secret set HOMEBREW_TAP_TOKEN --repo ngobe-ai/ngobe-cli`. Without it, publishing skips Homebrew with a warning.
4. After adding either secret, publish the current release to it: `gh workflow run publish.yml -f version=0.2.0`.
5. npm is paused with the repository variable `NPM_PUBLISH=false` (set 2026-10-19, until the `ngobe-ai` npm organization exists). Resume with `gh variable set NPM_PUBLISH --body true --repo ngobe-ai/ngobe-cli`, then publish the latest version: `gh workflow run publish.yml -f version=<version> -f channels=npm`.
6. **Actions settings:** the release job uses the built-in `GITHUB_TOKEN` with `contents: write` (declared in the workflow), so no extra secret is needed for GitHub Releases. Linux arm64 builds use GitHub's `ubuntu-24.04-arm` runners, which are free for public repositories.

## Cutting a release

    bun run release patch "what changed, in a few words"   # or minor / major / 0.4.0-rc.1
    bun run release patch --dry-run                         # the checks only

`scripts/release.ts` refuses unless you're on `main`, with nothing uncommitted, and up to date with `origin/main`. It bumps `package.json`, then runs the tests, the typecheck, the build and the Node smoke test (v0.3.6 failed CI on Node only); if one fails, `package.json` goes back and nothing is committed. Then it commits `release: <version> — <summary>`, tags `v<version>` (annotated) and pushes `main` and the tag, which starts the release workflow. It prints the `gh run watch` command to follow it.

A version with a hyphen (`0.4.0-rc.1`) becomes a GitHub pre-release and is published to npm under the `next` tag; Homebrew is left alone.

Release assets (names carry no version, so `releases/latest/download/<name>` always works):

| Asset | For |
|---|---|
| `ngobe-linux-x64.tar.gz` | Linux x86-64 with AVX2 (most servers) |
| `ngobe-linux-x64-baseline.tar.gz` | Linux x86-64 without AVX2 (older CPUs, some VMs) |
| `ngobe-linux-arm64.tar.gz` | Linux ARM64 (Graviton, Ampere, Raspberry Pi 4/5 with a 64-bit OS) |
| `ngobe-darwin-arm64.tar.gz` | macOS on Apple Silicon |
| `ngobe-darwin-x64.tar.gz` | macOS on Intel |
| `SHA256SUMS` | Checksums; `install.sh` and `ngobe update` refuse files that don't match |

## Building locally

    bun run build:binaries                     # every target into dist-bin/ (cross-compiles; ~1 minute)
    bun scripts/build-binaries.ts linux-x64    # one target
    bun scripts/homebrew-formula.ts 0.2.0 dist-bin/SHA256SUMS > ngobe.rb

Test an installer run against local files:

    (cd dist-bin && python3 -m http.server 8711 &)
    NGOBE_DOWNLOAD_BASE=http://localhost:8711 NGOBE_INSTALL_DIR=/tmp/ngobe-bin sh install.sh

## When something goes wrong

- A job failed after the GitHub Release was created: fix and re-run the failed jobs (npm and Homebrew are idempotent per version up to the push).
- A bad release: `gh release delete v0.x.y --cleanup-tag`, then `npm deprecate ngobe@0.x.y "broken, use 0.x.z"` (npm only allows unpublishing within 72 hours), and release a fixed version. Users on the standalone binary pick it up with `ngobe update`.
- macOS binaries are ad-hoc signed, not notarized. Installs through `curl | sh` and Homebrew aren't quarantined, so Gatekeeper doesn't block them; a binary downloaded with a browser needs `xattr -d com.apple.quarantine ngobe`.
