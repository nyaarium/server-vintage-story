#!/bin/bash

export APP_NAME="vintage-story"

set -e
cd "$(dirname "$0")"

git fetch --prune
git pull || true

if [ -f "discord-config.json5" ]; then
    ./update-mods.sh
fi

export APP_SERVICE=true
./run.sh

docker logs -f --tail 0 $APP_NAME
