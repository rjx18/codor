#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  exit 0
fi

exec codor mirror-hook codex "$1"
