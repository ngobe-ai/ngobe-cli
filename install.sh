#!/bin/sh
# Install the ngobe CLI from GitHub Releases.
#
#   curl -fsSL https://raw.githubusercontent.com/ngobe-ai/ngobe-cli/main/install.sh | sh
#
# Environment:
#   NGOBE_VERSION        version to install, e.g. 0.3.0 (default: the latest release)
#   NGOBE_INSTALL_DIR    where to put the binary (default: ~/.local/bin)
#   NGOBE_DOWNLOAD_BASE  base URL of the release files (mirrors, testing)
set -eu

REPO="ngobe-ai/ngobe-cli"
INSTALL_DIR="${NGOBE_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${NGOBE_VERSION:-latest}"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'ngobe install: %s\n' "$*" >&2
  exit 1
}

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "no prebuilt binary for $os; install with npm instead (Node 22.13+): npm install -g ngobe" ;;
esac
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "no prebuilt binary for $arch; install with npm instead: npm install -g ngobe" ;;
esac
# A shell running under Rosetta on Apple Silicon reports x86_64; the native build is better.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
if [ "$os" = linux ] && { ldd --version 2>&1 | grep -qi musl || [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; }; then
  fail "musl-based Linux (e.g. Alpine) isn't supported by the prebuilt binaries; install with npm instead: npm install -g ngobe"
fi
# x64 CPUs without AVX2 (old hardware, some virtual machines) need the baseline build.
suffix=""
if [ "$os" = linux ] && [ "$arch" = x64 ] && ! grep -qw avx2 /proc/cpuinfo 2>/dev/null; then
  suffix="-baseline"
fi
asset="ngobe-$os-$arch$suffix.tar.gz"

if [ -n "${NGOBE_DOWNLOAD_BASE:-}" ]; then
  base="$NGOBE_DOWNLOAD_BASE"
elif [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/v${VERSION#v}"
fi

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  fail "curl or wget is required"
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required to verify the download"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading $asset ($VERSION)..."
fetch "$base/$asset" "$tmp/$asset" || fail "download failed: $base/$asset"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "download failed: $base/SHA256SUMS"
expected=$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
[ -n "$expected" ] || fail "$asset is not listed in SHA256SUMS"
actual=$(sha "$tmp/$asset")
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset (expected $expected, got $actual); not installing"

tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$INSTALL_DIR"
# Swap in atomically so an ngobe that is already running keeps working.
cp "$tmp/ngobe" "$INSTALL_DIR/.ngobe.new"
chmod 755 "$INSTALL_DIR/.ngobe.new"
mv -f "$INSTALL_DIR/.ngobe.new" "$INSTALL_DIR/ngobe"
installed=$("$INSTALL_DIR/ngobe" --version 2>/dev/null) || fail "installed $INSTALL_DIR/ngobe, but it doesn't run on this machine"
say "Installed ngobe $installed to $INSTALL_DIR/ngobe"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    say ""
    say "$INSTALL_DIR is not on your PATH. Add it to your shell profile (~/.bashrc, ~/.zshrc or ~/.profile):"
    say "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
say ""
say "Next, point it at your model and check the setup:"
say "  export NGOBE_BASE_URL=http://localhost:12434/engines/v1   # Docker Model Runner"
say "  export NGOBE_MODEL=<model id from: docker model ls>"
say "  ngobe doctor"
