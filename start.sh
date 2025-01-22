#!/bin/bash

export APP_SERVICE=true
./run.sh
docker logs -f vintage-story
