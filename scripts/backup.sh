#!/bin/bash
# OpusMax Proxy — SQLite backup script
# Creates a consistent backup of the database using SQLite's online backup API.

set -euo pipefail

BACKUP_DIR="/opt/opusmax-proxy/backups"
DB_PATH="/opt/opusmax-proxy/data/opusmax.db"
RETENTION_DAYS=7

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/opusmax_$TIMESTAMP.db"

# Use node to create a consistent backup (SQLite online backup API)
# This safely copies the DB even while it's being written to.
node -e "
const Database = require('better-sqlite3');
const fs = require('fs');
const src = new Database('$DB_PATH');
const dest = new Database('$BACKUP_FILE');
src.backup(dest);
dest.close();
src.close();
console.log('Backup created: $BACKUP_FILE');
"

# Compress the backup
gzip "$BACKUP_FILE"
echo "Compressed: ${BACKUP_FILE}.gz"

# Remove backups older than retention period
find "$BACKUP_DIR" -name '*.gz' -mtime +$RETENTION_DAYS -delete
echo "Cleanup complete (retention: $RETENTION_DAYS days)"

# Report
ls -lh "$BACKUP_DIR"
