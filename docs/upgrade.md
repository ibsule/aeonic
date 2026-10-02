# Upgrade and rollback

Read release notes and take a tested, consistent backup before every upgrade. Aeonic migrations are
forward-only; rollback requires restoring the pre-upgrade database with matching object state.

## Create a consistent backup

Create the host backup directory first, stop every process that can change the shared data volume,
then archive the entire volume. The explicit bind mount keeps the archive outside Docker's named
volume.

```bash
mkdir -p "$PWD/backups"
docker compose stop api worker ai-worker
docker compose run --rm --no-deps \
  -v "$PWD/backups:/backup" \
  api tar --create --gzip \
    --file "/backup/aeonic-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" \
    --directory /app/data .
docker compose up -d
```

Record the archive SHA-256 (`sha256sum backups/aeonic-*.tar.gz`), release version, and creation time.
Copy the archive to encrypted storage off the Compose host. A backup is not accepted as release
evidence until a restoration rehearsal succeeds on a separate disposable Compose project.

## Upgrade

```bash
git fetch --tags
git checkout <reviewed-release-tag>
docker compose build
docker compose run --rm api node apps/api/dist/doctor.js
docker compose up -d
docker compose ps
```

The API applies checked-in migrations during startup. The worker waits for API readiness and does
not race the initial migration. Verify `/health/ready`, sign in, upload a small representative file,
and confirm its job reaches `succeeded` in the dashboard.

Do not run `docker compose down -v`; `-v` deletes named volumes and application data. Normal
`docker compose down` retains data.

## Rollback

1. Stop the stack.
2. Move the current `aeonic-data` volume aside; do not overwrite the only copy.
3. Restore the complete pre-upgrade archive into a fresh `aeonic-data` volume. Reject archive entries
   with absolute paths or `..` components before extraction.
4. Check out the prior reviewed release.
5. Rebuild and run the doctor.
6. Start the stack and repeat readiness, sign-in, download, range-request, and upload smoke tests.

Restoring only SQLite while keeping newer objects can leave control-plane and media data out of
sync. Treat them as one recovery unit.

## Restoration rehearsal record

For each release candidate, record:

- Source release and image digests, database size, object count, and archive SHA-256.
- Restore host architecture, Docker/Compose versions, start and finish times, and recovery duration.
- Doctor output, SQLite integrity and foreign-key results, and representative asset checks.
- Whether the prior release started successfully after restoration.
- Any manual intervention. A workaround must become documentation or a tracked defect before release.
