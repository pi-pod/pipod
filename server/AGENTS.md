Never write or run unit tests. Typecheck (`npm run check`) and build still apply.

A local migration rehearsal must unset `DATABASE_URL` and `MIGRATION_DATABASE_URL` and use only an explicit disposable database URL.

Do not hand-edit a `[shared]` file in `src/core/`: change it in `../cli` and run `scripts/sync-core.sh ../cli`.

Schema changes are new files in `migrations/` numbered after the highest existing one. Never edit `000_baseline.sql`.
