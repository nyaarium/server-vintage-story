#!/bin/sh

if [ -e "output.log" ]; then
	LOG_FILE="output.log"
else
	LOG_FILE="/app/output.log"
fi

gameUptime="$(cat $LOG_FILE | grep -E "\[Server Event\] Dedicated Server now running" | grep -Eo '^[^ ]* [^ ]*')"
connects="$(cat $LOG_FILE | grep -E '\[Server Event\] .* joins.' | wc -l)"
disconnects="$(cat $LOG_FILE | grep -E '\[Server Event\] Player .* left.|\[Server Event\] Player .* got removed.' | wc -l)"


printf "{"

if [ -z "$gameUptime" ]; then
	firstLine="$(head -1 $LOG_FILE)"
	if [ "$firstLine" == "down" ]
	then
		printf "status: 'down',"
		printf "uptime: null,"
	else
		printf "status: 'starting',"
		printf "uptime: $(stat -c %Z /proc/),"
	fi
else
	printf "status: 'running',"
	printf "uptime: {date:'${gameUptime}'},"

	printf "info: {"
	printf "players: $(($connects - $disconnects)),"
	printf "},"
fi

printf "}"
