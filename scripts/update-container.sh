#!/bin/sh
# Compatibility entry point; all management uses Docker Compose.
set -eu
exec sh "$(dirname "$0")/manage.sh" update
