# SB01 runtime tests

Run the full mock/unit suite with `npm test` from `platform/runtime`.

Run the three real-Postgres integration suites using only a disposable local database with:

```powershell
npm run test:postgres
```

The script starts an embedded PostgreSQL cluster on an available localhost port, creates a temporary `wstera_billing_test` database, applies migrations `0001` through `0003`, runs the outbox crash-window, LR-2E isolation, and durable JSONB webhook suites, then stops PostgreSQL and removes its temporary data directory. It never connects to Docker, LAB, Project A, or a hosted database. The `BILLING_DATABASE_URL` exists only in the child test process and points to localhost.

The test password is randomly generated for each temporary cluster and must not be reused for any persistent database.
