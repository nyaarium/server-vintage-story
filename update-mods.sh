#!/bin/bash

export APP_NAME="vintage-story"

set -e
cd "$(dirname "$0")"

mkdir -p data/saves data/mods data/logs

docker build -t $APP_NAME docker/

./stop.sh
sleep 1  # Give Docker time to clean up

DISCORD_VOL=""
if [ -f "discord-config.json5" ]; then
    DISCORD_VOL="-v $(pwd)/data/discord-config.json5:/data/discord-config.json5:ro"
fi

docker run --rm -i \
    --name $APP_NAME \
    -v "$(pwd)/data/saves:/data" \
    -v "$(pwd)/data/mods:/data/Mods" \
    -v "$(pwd)/data/logs:/data/logs" \
    -v "$(pwd)/data/mods.json5:/data/mods.json5" \
    ${DISCORD_VOL} \
    $APP_NAME \
    /bin/bash -c "cd /root/ && node mod-updater.mjs;"
