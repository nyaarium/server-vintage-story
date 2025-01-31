#!/bin/bash

set -e
cd "$(dirname "$0")"

mkdir -p data

./stop.sh

docker build -t vintage-story docker/

if [ "${APP_SERVICE:-}" = "true" ]; then
    DETACHED="-d"
else
    DETACHED=""
fi

docker run --rm -it $DETACHED \
    --name vintage-story \
    -v "$(pwd)/data:/data" \
    -v "$(pwd)/Mods.json5:/configs/Mods.json5" \
    -p 8080:8080/tcp \
    -p 42420:42420/tcp \
    vintage-story \
    $@
