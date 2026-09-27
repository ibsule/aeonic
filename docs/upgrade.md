# Upgrade and rollback

Read release notes and take a tested, consistent backup before every upgrade. Aeonic migrations are
forward-only; rollback requires restoring the pre-upgrade database with matching object state.

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
2. Restore the complete pre-upgrade `aeonic-data` backup.
3. Check out the prior reviewed release.
4. Rebuild and run the doctor.
5. Start the stack and repeat readiness and upload smoke tests.

Restoring only SQLite while keeping newer objects can leave control-plane and media data out of
sync. Treat them as one recovery unit.
