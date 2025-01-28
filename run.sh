#!/bin/bash

set -e
cd "$(dirname "$0")"

mkdir -p data

docker build -t vintage-story docker/

docker rm -f vintage-story 2>/dev/null || true

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
