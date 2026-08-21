# OpusMax Proxy — Backup & Recovery

## Backup Strategy

Automated backups run daily via cron, keeping 7 days of compressed backups.

### Automated Backup (cron)

```bash
# Add to crontab (crontab -e)
# Daily at 2:00 AM
0 2 * * * /opt/opusmax-proxy/scripts/backup.sh >> /var/log/opusmax/backup.log 2>&1
```

### Manual Backup

```bash
cd /opt/opusmax-proxy
bash scripts/backup.sh
```

## Restore

```bash
# Stop the application
pm2 stop opusmax-proxy

# Restore from backup
gunzip -c backups/opusmax_20260821_020000.db.gz > /opt/opusmax-proxy/data/opusmax.db

# Set permissions
sudo chown ubuntu:ubuntu /opt/opusmax-proxy/data/opusmax.db

# Restart
pm2 start opusmax-proxy
```

## Verify Backup

```bash
# Check backup integrity
node -e "
const Database = require('better-sqlite3');
const db = new Database('backups/opusmax_LATEST.db');
const shares = db.prepare('SELECT COUNT(*) as cnt FROM share_index').get();
console.log('Share keys:', shares.cnt);
console.log('Tables:', db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r => r.name));
db.close();
"
```

## Database Location

```
/opt/opusmax-proxy/data/opusmax.db       # Main database
/opt/opusmax-proxy/data/opusmax.db-wal    # WAL file (created automatically)
/opt/opusmax-proxy/data/opusmax.db-shm    # Shared memory (created automatically)
```

## Important Notes

- **Do NOT copy the database file directly** while the server is running. Use the backup script which leverages SQLite's online backup API for consistency.
- The WAL file (`-wal`) contains uncommitted changes. Restoring only the `.db` file without the WAL may lose recent data.
- Backups are compressed with gzip. Decompress before restoring.
- The backup script creates a new empty database if the source doesn't exist (startup safeguard).
