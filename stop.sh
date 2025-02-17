#!/bin/bash

export APP_NAME="vintage-story"

set -e
cd "$(dirname "$0")"

docker kill --signal=SIGTERM $APP_NAME || true

docker rm -f $APP_NAME 2>/dev/null || true
