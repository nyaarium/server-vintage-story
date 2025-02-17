#!/bin/bash

set -e
cd "$(dirname "$0")"

if [ $# -eq 0 ]; then
    echo "Expected a command as a parameter"
    exit 1
fi

command="$*"
docker exec vintage-story bash -c "echo \"$command\" > /app/input.fifo" 
