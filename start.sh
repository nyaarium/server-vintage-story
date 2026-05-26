#!/bin/bash

set -e
cd "$(dirname "$0")"

# Ensure data directories exist
mkdir -p data/saves data/mods data/logs data/mod-configs data/host-configs

# First positional selects the service explicitly. The orchestrator
# (server-config.json5) always passes one of these.
mode="${1:-}"
shift || true

case "$mode" in
    game)
        # Long-lived game server: build + start the app container, then attach.
        docker compose up -d --build
        exec docker exec -i app /app/start-server.sh
        ;;
    mod-updater)
        # Ephemeral tool run. --build builds the updater's own image (cached/fast)
        # so this works even if the game was never started. Does NOT start the game.
        docker compose run --rm --build -T mod-updater bun cli.ts "$@"
        ;;
    *)
        echo "Usage: start.sh {game | mod-updater <command> [args]}" >&2
        exit 2
        ;;
esac
