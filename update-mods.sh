#!/bin/bash

set -e

mkdir -p data

docker build -t vintage-story docker/

docker rm -f vintage-story 2>/dev/null || true

docker run --rm -i \
    --name vintage-story \
    -v "$(pwd)/data:/data" \
    -v "$(pwd)/Mods.json5:/configs/Mods.json5" \
    vintage-story \
    /bin/bash -c "cd /root/ && node mod-updater.mjs;"
