#!/bin/bash

set -e
cd "$(dirname "$0")"

export APP_SERVICE=true
./run.sh
docker logs -f vintage-story
