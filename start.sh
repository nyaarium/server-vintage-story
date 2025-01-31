#!/bin/bash

set -e
cd "$(dirname "$0")"

git fetch --prune
git pull

export APP_SERVICE=true
./run.sh

docker wait vintage-story
