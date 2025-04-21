#!/bin/bash

SERVERDIR=/app
cd $SERVERDIR

_term() { 
	echo "Caught kill signal! Gracefully shutting down."

	echo "/stop" > input.fifo

	was_gracefully_killed=true
	
	# Wait for server to finish saving (up to 25 seconds)
	for i in {1..25}; do
		if ! kill -0 "$child_server" 2>/dev/null; then
			break
		fi
		sleep 1
	done

	# If server is still running, force kill it
	if kill -0 "$child_server" 2>/dev/null; then
		was_gracefully_killed=false
		kill -9 "$child_server" || true
	fi

	kill -9 "$child_monitor" || true
	# kill -9 "$child_log_viewer" || true

	[ -p "input.fifo" ] && rm input.fifo

	if $was_gracefully_killed; then
		echo "Server shutdown complete."
	else
		echo "Server forcefully killed."
	fi
}
trap _term TERM INT

LOG_FILE_CURRENT="/data/logs/output.log"
LOG_FILE_NEXT="/data/logs/output-last.log"
[ ! -f "$LOG_FILE_CURRENT" ] && touch "$LOG_FILE_CURRENT"


# Start monitor
pushd /monitor
node monitor.mjs &
child_monitor=$!
popd


# Server start command
export DOTNET_ROOT=/root/.dotnet
export PATH=$PATH:$DOTNET_ROOT:$DOTNET_ROOT/tools
COMMAND=(
	dotnet
	VintagestoryServer.dll
	--dataPath
	/data/saves
)


# Pipes and logs
mkfifo input.fifo
tail -f input.fifo | "${COMMAND[@]}" 2>&1 | tee $LOG_FILE_CURRENT &
child_server=$!

# Start real-time log viewer (if server is quiet)
# echo "Starting real-time log viewer..."
# tail -f /data/logs/output.log &
# child_log_viewer=$!


# Wait for server to finish and kill monitor
wait "$child_server"

# Kill the log viewer
# kill $child_log_viewer 2>/dev/null || true


# Rotate logs
[ -f "$LOG_FILE_NEXT" ] && rm "$LOG_FILE_NEXT"
cp "$LOG_FILE_CURRENT" "$LOG_FILE_NEXT"
echo "down" > "$LOG_FILE_CURRENT"
