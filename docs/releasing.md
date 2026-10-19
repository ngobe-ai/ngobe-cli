# CI and releases

## What runs when

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | push to `main`, every pull request, and before each release | Typecheck, `bun test`, build, Node smoke test (Ubuntu and macOS); `npm pack` installed globally on Node 22 and 24; a Linux binary built, smoke-tested and installed through `install.sh` from a local mirror; ShellCheck on `install.sh` |
| `release.yml` | pushing a tag `v*` | Checks the tag matches `package.json`, runs CI, builds each binary on its own platform and runs it, creates the GitHub Release (archives, `SHA256SUMS`, `install.sh`), publishes to npm with provenance, updates the Homebrew tap, then installs the release with `curl … \| sh` on Ubuntu and macOS |
| `live.yml` | daily, or by hand | The live tests against the official version, release-note and advisory endpoints, which can change format without notice |

Dependabot opens weekly PRs for GitHub Actions and npm dependencies.

## One-time setup

1. **Make `ngobe-ai/ngobe-cli` public.** Release files, `raw.githubusercontent.com/…/install.sh` and npm provenance all need it. (Settings → General → Danger Zone → Change visibility.)
2. **npm:** create an npm account or org that will own `ngobe` (the name was free on 2026-10-19), then a granular access token with publish rights. Add it as the repository secret `NPM_TOKEN`. Without it, the release skips npm with a warning. Once the package exists you can switch to npm trusted publishing (OIDC) and delete the token.
3. **Homebrew:** create the public repository `ngobe-ai/homebrew-tap` (a README is enough; the workflow creates `Formula/ngobe.rb`). Create a fine-grained token with Contents read/write on that repository only, and add it as the secret `HOMEBREW_TAP_TOKEN`. Without it, the release skips Homebrew with a warning.
4. **Actions settings:** the release job uses the built-in `GITHUB_TOKEN` with `contents: write` (declared in the workflow), so no extra secret is needed for GitHub Releases. Linux arm64 builds use GitHub's `ubuntu-24.04-arm` runners, which are free for public repositories.

## Cutting a release

    npm version minor            # or patch / major / 0.4.0-rc.1; updates package.json, commits, tags v0.x.y
    git push --follow-tags

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
