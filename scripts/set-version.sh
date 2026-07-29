#!/bin/sh
set -eu

version="${1:-}"
if [ -z "$version" ]; then
  echo "Usage: set-version.sh <version>" >&2
  exit 64
fi

case "$version" in
  *[!0-9A-Za-z.+-]* | "")
    echo "Version contains unsupported characters: $version" >&2
    exit 64
    ;;
esac

echo "Setting version to: $version"

if [ "$(uname)" = "Darwin" ]; then
  sed_in_place() {
    sed -i '' "$@"
  }
else
  sed_in_place() {
    sed -i "$@"
  }
fi

for package_file in package.json apps/control-plane/package.json; do
  if [ ! -f "$package_file" ]; then
    echo "Missing package manifest: $package_file" >&2
    exit 1
  fi

  sed_in_place \
    "s/\"version\": \"[^\"]*\"/\"version\": \"$version\"/" \
    "$package_file"
  echo "  Updated $package_file"
done

echo "Done."
