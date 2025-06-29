#!/bin/bash

export APP_NAME="vintage-story"

set -e
cd "$(dirname "$0")"

mkdir -p data/saves data/mods data/logs

docker build -t $APP_NAME -f docker/Dockerfile .

./stop.sh
sleep 1  # Give Docker time to clean up

if [ "${APP_SERVICE:-}" = "true" ]; then
    DETACHED="-d"
else
    DETACHED=""
fi

docker run --rm -it $DETACHED \
    --name $APP_NAME \
    --log-driver local \
    --log-opt max-size=200k \
    --log-opt max-file=3 \
    -v "$(pwd)/data/saves:/data" \
    -v "$(pwd)/data/mods:/data/Mods" \
    -v "$(pwd)/data/logs:/data/logs" \
    -v "$(pwd)/data/mods.json5:/data/mods.json5" \
    -p 8080:8080/tcp \
    -p 42420:42420/tcp \
    $APP_NAME \
    $@
