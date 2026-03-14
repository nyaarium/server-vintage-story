#!/bin/bash

set -e
cd "$(dirname "$0")"

# Ensure data directories exist
mkdir -p data/saves data/mods data/logs

# Build and start container
docker compose up -d --build

if [ $# -gt 0 ]; then
    docker exec app bash -c "cd /root && $*"
else
    exec docker exec -i app /app/start-server.sh
fi
