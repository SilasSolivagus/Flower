#!/bin/sh
set -e
node migrate.mjs
exec env -u DATABASE_ADMIN_URL -u FLOWER_APP_DB_PASSWORD node apps/web/server.js
