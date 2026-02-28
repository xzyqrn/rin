
## 2024-03-16 - [Missing Database Indexes causing Full Table Scans]
**Learning:** Found a missing index on SQLite database that was causing full table scans or forcing the database to build a temporary B-tree for `ORDER BY` and `GROUP BY` operations. The application frequently queried memories, reminders, notes, and API metrics with `ORDER BY`, which required a composite index `(user_id, sort_column)` rather than just a single index on `user_id`.
**Action:** When working on DB optimizations, review the database access patterns using `EXPLAIN QUERY PLAN` specifically when `ORDER BY` or `GROUP BY` are involved, and remember that SQLite can optimize away a sorting step if a composite index matches both the filtering columns and the sort columns in order.

## 2025-02-15 - [SQLite WAL Mode Improves Write Performance]
**Learning:** The default SQLite journal mode is `DELETE`, which requires waiting for physical disk syncing for every write transaction to guarantee durability, making write-heavy applications significantly slower. This application does a lot of small writes to log API calls, user messages, rate limiting, and metrics.
**Action:** When working with SQLite on write-heavy apps, use `db.pragma('journal_mode = WAL');` and `db.pragma('synchronous = NORMAL');`. The Write-Ahead Log reduces fsyncs and improves concurrency, resulting in a 10x-100x speedup for write performance.
