#!/bin/bash

export APP_NAME="vintage-story"

set -e
cd "$(dirname "$0")"

if [ "$(docker container inspect -f '{{.State.Running}}' "$APP_NAME" 2>/dev/null)" != "true" ]; then
    echo "App is not running"
    exit 0
fi

echo "Sending stop command to app..."
./send.sh /stop

echo "Waiting for app to stop..."
success=false
for i in {1..20}; do
    if [ "$(docker container inspect -f '{{.State.Running}}' "$APP_NAME" 2>/dev/null)" != "true" ]; then
        success=true
        break
    fi
    sleep 1
done

if [ "$success" != "true" ]; then
    echo "App did not stop gracefully after 20 seconds"
    echo "Sending SIGTERM and waiting up to 5 seconds..."
    docker kill --signal=SIGTERM "$APP_NAME" --time 5 || true
fi

sleep 1

docker rm -f "$APP_NAME" 2>/dev/null || true
