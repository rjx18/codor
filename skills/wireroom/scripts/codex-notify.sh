#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  exit 0
fi

exec wireroom mirror-hook codex "$1"
