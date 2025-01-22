#!/bin/bash

# See Dockerfile for the version
if [ -z "$GAME_VERSION" ]; then
	echo "GAME_VERSION is not set"
	exit 1;
fi

URL="https://cdn.vintagestory.at/gamefiles/stable/vs_server_linux-x64_${GAME_VERSION}.tar.gz"

mkdir -p /app
cd /app
if [ ! -e "server.sh" ]; then
	# Assert: Check if the specified version exists
	if [ "`curl -sI $URL | head -n 1 | grep -o '200'`" != "200" ]; then
		echo ""
		echo "    Failed to get version $GAME_VERSION"
		echo ""
		echo "    URL: $URL"
		echo ""
		exit 1;
	fi

	# Download it
	curl -o server.tar.gz $URL
	tar xzf server.tar.gz
	rm server.tar.gz
	chmod +x server.sh
fi
