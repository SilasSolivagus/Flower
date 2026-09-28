#!/bin/sh
set -e
node migrate.mjs
exec node apps/web/server.js
