#!/bin/bash

set -e
cd "$(dirname "$0")"

docker kill --signal=SIGTERM vintage-story || true

docker rm -f vintage-story 2>/dev/null || true
