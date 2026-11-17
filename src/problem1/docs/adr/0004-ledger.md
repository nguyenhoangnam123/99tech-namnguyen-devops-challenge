# 0004: Double-entry ledger with invariants in the database

**Status:** accepted

## Decision

- Every balance change is a journal of postings that nets to zero per asset.
  Core refuses to build an unbalanced journal.
- Postgres enforces the same rules independently:
  - A deferred constraint trigger refuses to commit an unbalanced journal.
  - `journal_entries` is append-only (update, delete and truncate are rejected).
  - A CHECK keeps user balances non-negative, so concurrent orders cannot overspend.
- Every transaction takes all its account locks in one id-ordered statement before
  posting. Placement locks two accounts; settlement locks every account its batch can
  touch, up front. Locking per journal deadlocked settlement against new orders: the
  traders-50 SLO run found it, and an integration test now reproduces it.
- Settlement re-checks every event against the order rows (owner, symbol, limit price,
  size) and stops the line instead of moving money on a bad event. The owner check also
  keeps postings inside the lock set, which is built from the event.

## Consequences

- Insufficient funds is decided by the database, under the row lock, not by a read
  that can race. The e2e double-spend test fires concurrent orders to prove it.
- The up-front lock set is a superset: both assets for a closed order, and both fee
  accounts for the whole transaction. Fee rows are hot, so settlement is serialised per
  asset. That is fine for one settler; sharded fee accounts are the fix if it binds.
- A refused journal leaves the transaction unusable. The unit of work refuses to report
  success after one, so a caller cannot commit a silent rollback.
- Deferred to wave 2:
  - A separate app database role that cannot disable triggers.
  - Balances maintained by a statement-level trigger over the inserted journal rows,
    replacing the app's own update, so balance drift becomes impossible by construction.
    Until then the e2e suite reconciles balances against the journal after every file.
