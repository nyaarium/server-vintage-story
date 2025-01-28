#!/bin/bash

set -e
cd "$(dirname "$0")"

docker kill --signal=SIGTERM vintage-story
