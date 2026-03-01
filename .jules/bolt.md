
## 2024-03-16 - [Missing Database Indexes causing Full Table Scans]
**Learning:** Found a missing index on SQLite database that was causing full table scans or forcing the database to build a temporary B-tree for `ORDER BY` and `GROUP BY` operations. The application frequently queried memories, reminders, notes, and API metrics with `ORDER BY`, which required a composite index `(user_id, sort_column)` rather than just a single index on `user_id`.
**Action:** When working on DB optimizations, review the database access patterns using `EXPLAIN QUERY PLAN` specifically when `ORDER BY` or `GROUP BY` are involved, and remember that SQLite can optimize away a sorting step if a composite index matches both the filtering columns and the sort columns in order.

## 2025-02-15 - [SQLite WAL Mode Improves Write Performance]
**Learning:** The default SQLite journal mode is `DELETE`, which requires waiting for physical disk syncing for every write transaction to guarantee durability, making write-heavy applications significantly slower. This application does a lot of small writes to log API calls, user messages, rate limiting, and metrics.
**Action:** When working with SQLite on write-heavy apps, use `db.pragma('journal_mode = WAL');` and `db.pragma('synchronous = NORMAL');`. The Write-Ahead Log reduces fsyncs and improves concurrency, resulting in a 10x-100x speedup for write performance.

## 2025-02-17 - Avoid db.prepare on every call
**Learning:** `better-sqlite3` is fast, but calling `db.prepare()` on every single database function call introduces unnecessary overhead. For highly frequent operations (like `getAllFacts`, `saveMemory`, etc.), it's better to cache the prepared statements. Note that the cache must be per-database-connection to be safe.
**Action:** Extract `db.prepare` calls into a lazy-initialization cache bound to the database instance itself (e.g. `db._statements = db._statements || {}`) to avoid reparsing the SQL on every call safely.

## 2024-10-24 - [N+1 Latency with Sequential Database Reads in Bot Handlers]
**Learning:** Found sequential asynchronous reads (`await db.collection...`) in the main message handler before LLM processing begins. In Firebase Firestore or remote database backends, doing 4 separate read requests sequentially adds significant latency (4x network RTT) before the application even starts processing the message.
**Action:** Always group independent data requirements at the beginning of an async function (like fetching user facts, session history, tokens, and settings) and fetch them concurrently using `Promise.all` to reduce network roundtrips from `O(N)` to `O(1)`.
