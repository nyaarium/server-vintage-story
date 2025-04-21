#!/bin/bash

export APP_NAME="vintage-story"

set -e
cd "$(dirname "$0")"

mkdir -p data

docker build -t $APP_NAME docker/

./stop.sh
sleep 1  # Give Docker time to clean up

DISCORD_VOL=""
if [ -f "discord-config.json5" ]; then
    DISCORD_VOL="-v $(pwd)/discord-config.json5:/configs/discord-config.json5:ro"
fi

docker run --rm -i \
    --name $APP_NAME \
    -v "$(pwd)/data/saves:/var/data/saves" \
    -v "$(pwd)/data/mods:/var/data/saves/Mods" \
    -v "$(pwd)/data/logs:/var/data/logs" \
    -v "$(pwd)/data/mods.json5:/var/data/mods.json5" \
    ${DISCORD_VOL} \
    $APP_NAME \
    /bin/bash -c "cd /root/ && node mod-updater.mjs;"
