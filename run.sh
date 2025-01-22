#!/bin/bash

set -e

mkdir -p data

docker build -t vintage-story docker/

docker rm -f vintage-story 2>/dev/null || true

docker run --rm -it \
    --name vintage-story \
    -v "$(pwd)/data:/data" \
    -v "$(pwd)/Mods.json5:/configs/Mods.json5" \
    -p 8080:8080/tcp \
    -p 42420:42420/tcp \
    vintage-story \
    $@
