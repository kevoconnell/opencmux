#!/usr/bin/env bash

set -euo pipefail

script_path="${BASH_SOURCE[0]}"
while [ -L "$script_path" ]; do
  script_dir="$(cd "$(dirname "$script_path")" && pwd)"
  script_path="$(readlink "$script_path")"
  if [[ "$script_path" != /* ]]; then
    script_path="$script_dir/$script_path"
  fi
done

project_root="$(cd "$(dirname "$script_path")/.." && pwd -P)"

if ! command -v cmux >/dev/null 2>&1; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "cmux is not installed and Homebrew is unavailable for automatic install." >&2
    exit 1
  fi

  brew install cmux
fi

if [ ! -x "$project_root/node_modules/.bin/tsx" ]; then
  pnpm install --dir "$project_root"
fi
