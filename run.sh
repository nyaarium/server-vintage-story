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
    --log-driver local \
    --log-opt max-size=200k \
    --log-opt max-file=3 \
    -v "$(pwd)/data:/data" \
    -v "$(pwd)/mods.json5:/configs/mods.json5" \
    -p 8080:8080/tcp \
    -p 42420:42420/tcp \
    $APP_NAME \
    $@
