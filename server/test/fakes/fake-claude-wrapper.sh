#!/bin/sh
# A shell shim in front of the fake chat CLI that does NOT exec it: killing only this shell would leave the fake
# running with stdout open. Used to check that a chat run kills the whole process group.
bun "$(dirname "$0")/fake-claude-chat.ts" "$@" &
wait
