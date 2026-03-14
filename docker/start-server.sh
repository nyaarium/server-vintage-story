#!/bin/bash

set -e
cd /app

export DOTNET_ROOT=/root/.dotnet
export PATH=$PATH:$DOTNET_ROOT:$DOTNET_ROOT/tools

exec dotnet VintagestoryServer.dll --dataPath /data
