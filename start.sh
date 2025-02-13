#!/bin/bash

set -e
cd "$(dirname "$0")"

git fetch --prune
git pull || true

if [ -f "discord-config.json5" ]; then
    ./update-mods.sh
fi

export APP_SERVICE=true
./run.sh

docker wait vintage-story
