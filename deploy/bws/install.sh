#!/bin/sh
set -eu

version='2.1.0'
target_arch="${1:?Docker TARGETARCH is required}"

case "$target_arch" in
  amd64)
    rust_target='x86_64-unknown-linux-musl'
    checksum='f59ee150e42b82128d437087e9bac920053c6bfddcb960d20ce9386e5ac9bba6'
    ;;
  arm64)
    rust_target='aarch64-unknown-linux-musl'
    checksum='eb0f1ae61d1c3b74244d2841233276e05c77e8be4da197ed90fc6248387005e1'
    ;;
  *)
    printf 'Unsupported Docker TARGETARCH: %s\n' "$target_arch" >&2
    exit 1
    ;;
esac

archive="bws-${rust_target}-${version}.zip"
url="https://github.com/bitwarden/sdk/releases/download/bws-v${version}/${archive}"

mkdir -p /out /tmp/bws
curl --fail --silent --show-error --location --retry 3 "$url" --output "/tmp/${archive}"
printf '%s  %s\n' "$checksum" "/tmp/${archive}" | sha256sum -c -s
unzip -q "/tmp/${archive}" -d /tmp/bws
install -m 0755 /tmp/bws/bws /out/bws
/out/bws --version
