#!/bin/bash

set -e
cd "$(dirname "$0")"

mkdir -p data

docker build -t vintage-story docker/

./stop.sh
sleep 1  # Give Docker time to clean up

DISCORD_VOL=""
if [ -f "discord-config.json5" ]; then
    DISCORD_VOL="-v $(pwd)/discord-config.json5:/configs/discord-config.json5:ro"
fi

docker run --rm -i \
    --name vintage-story \
    -v "$(pwd)/data:/data" \
    -v "$(pwd)/mods.json5:/configs/mods.json5" \
    ${DISCORD_VOL} \
    vintage-story \
    /bin/bash -c "cd /root/ && node mod-updater.mjs;"
