#!/bin/bash

export APP_NAME="vintage-story"

set -e
cd "$(dirname "$0")"

mkdir -p data

./stop.sh

docker build -t $APP_NAME docker/

if [ "${APP_SERVICE:-}" = "true" ]; then
    DETACHED="-d"
else
    DETACHED=""
fi

docker run --rm -it $DETACHED \
    --name $APP_NAME \
    --log-opt max-size=5k \
    --log-opt max-file=1 \
    -v "$(pwd)/data:/data" \
    -v "$(pwd)/Mods.json5:/configs/Mods.json5" \
    -p 8080:8080/tcp \
    -p 42420:42420/tcp \
    $APP_NAME \
    $@
