#!/bin/bash

set -e
cd "$(dirname "$0")"

mkdir -p data

docker build -t vintage-story docker/

./stop.sh
sleep 1  # Give Docker time to clean up

docker run --rm -i \
    --name vintage-story \
    -v "$(pwd)/data:/data" \
    -v "$(pwd)/Mods.json5:/configs/Mods.json5" \
    vintage-story \
    /bin/bash -c "cd /root/ && node mod-updater.mjs;"
