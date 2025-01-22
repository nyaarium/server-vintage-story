#!/bin/bash

SERVERDIR=/app
cd $SERVERDIR

_term() { 
  echo "Caught kill signal! Gracefully shutting down."

  echo "/stop" > input.fifo
  
  # Wait for server to finish saving (up to 25 seconds)
  for i in {1..25}; do
    if ! kill -0 "$child_server" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  kill -TERM "$child_monitor" 2>/dev/null

  echo "Server shutdown complete."
}
trap _term SIGINT SIGTERM

LOG_FILE_CURRENT="output.log"
LOG_FILE_NEXT="output-last.log"
[ ! -f "$LOG_FILE_CURRENT" ] && touch "$LOG_FILE_CURRENT"


# Start monitor
pushd /monitor
node server.js &
child_monitor=$!
popd


# Server start command
export DOTNET_ROOT=/root/.dotnet
export PATH=$PATH:$DOTNET_ROOT:$DOTNET_ROOT/tools
COMMAND=(
  dotnet
  VintagestoryServer.dll
  --dataPath
  /data
)


# Pipes and logs
mkfifo input.fifo
tail -f input.fifo | "${COMMAND[@]}" 2>&1 | tee $LOG_FILE_CURRENT &
child_server=$!


# Wait for server to finish and kill monitor
wait "$child_server"
kill -TERM "$child_monitor" 2>/dev/null


# Rotate logs
[ -f "$LOG_FILE_NEXT" ] && rm "$LOG_FILE_NEXT"
cp "$LOG_FILE_CURRENT" "$LOG_FILE_NEXT"
echo "down" > "$LOG_FILE_CURRENT"
