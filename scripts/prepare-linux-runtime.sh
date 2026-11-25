#!/bin/sh
# Run as the container image build user (root), never with an image or provider credential.
set -eu
version=1.0.114
dest="/opt/agency-copilot-image-cli-$version"
if [ "$(id -u)" != 0 ] || [ "$(uname -m)" != x86_64 ] || [ -e "$dest" ] || [ -L "$dest" ]; then
  echo "Run as root on Linux x64 with no existing runtime at $dest." >&2
  exit 1
fi
umask 077
tmp=$(mktemp -d /opt/.copilot-image-runtime.XXXXXXXX)
trap 'rm -rf -- "$tmp"' EXIT
archive="$tmp/github-copilot-linux-x64-$version.tgz"
cd "$tmp"
npm pack --silent --ignore-scripts --registry=https://registry.npmjs.org "@github/copilot-linux-x64@$version"
test "$(openssl dgst -sha512 -binary "$archive" | openssl base64 -A)" = 'gHnINm9ffFqz+G19cQUqRe3lsTAQO3Tbdj7r7Bx1ktZvC5X6iXd/nfo1DRTj9magb52aGRiuwB3yvD1lkW68xQ=='
install -d -m 0755 "$tmp/runtime" "$tmp/runtime/cache"
mkdir -m 0700 "$tmp/home"
tar -xzf "$archive" --no-same-owner --strip-components=1 -C "$tmp/runtime"
test "$(sha256sum "$tmp/runtime/copilot" | cut -d ' ' -f 1)" = '990cc6cf4e171ef88b6e3c873f7b62c0dc044b223a7ace518ac284baf2578fc6'
chmod 0755 "$tmp/runtime/copilot"
env -i PATH=/usr/bin:/bin HOME="$tmp/home" TMPDIR="$tmp/home" COPILOT_AUTO_UPDATE=false \
  COPILOT_CACHE_HOME="$tmp/runtime/cache" "$tmp/runtime/copilot" help environment >/dev/null
test -d "$tmp/runtime/cache/pkg/linux-x64/$version"
chmod -R a+rX,go-w "$tmp/runtime"
mv -T --no-clobber "$tmp/runtime" "$dest"
test ! -e "$tmp/runtime"
