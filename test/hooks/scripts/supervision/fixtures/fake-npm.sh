#!/usr/bin/env bash
# Test-only stand-in for `npm`, so the bootstrap install path can be exercised
# without touching the network.
#
# Behaviour is driven entirely by env vars the test sets:
#   FAKE_NPM_LOG        file every invocation is appended to as "<cwd>\t<args>"
#   FAKE_NPM_FAIL_CI    non-empty → `ci` exits 1 (the out-of-sync-lockfile case)
#   FAKE_NPM_FAIL_ALL   non-empty → every subcommand exits 1
#
# `install`/`ci` create `node_modules` in the cwd and `run build` creates
# `dist/index.html`, which is exactly what the caller checks for afterwards.
set -u

printf '%s\t%s\n' "$PWD" "$*" >> "${FAKE_NPM_LOG:-/dev/null}"

[ -n "${FAKE_NPM_FAIL_ALL:-}" ] && exit 1

case "${1:-}" in
  ci)
    [ -n "${FAKE_NPM_FAIL_CI:-}" ] && exit 1
    mkdir -p node_modules && : > node_modules/.installed-by-ci
    ;;
  install)
    mkdir -p node_modules && : > node_modules/.installed-by-install
    ;;
  run)
    [ "${2:-}" = build ] || exit 1
    mkdir -p dist && printf '<div id="root"></div>\n' > dist/index.html
    ;;
  *) exit 1 ;;
esac
