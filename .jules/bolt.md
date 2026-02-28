
## 2024-03-16 - [Missing Database Indexes causing Full Table Scans]
**Learning:** Found a missing index on SQLite database that was causing full table scans or forcing the database to build a temporary B-tree for `ORDER BY` and `GROUP BY` operations. The application frequently queried memories, reminders, notes, and API metrics with `ORDER BY`, which required a composite index `(user_id, sort_column)` rather than just a single index on `user_id`.
**Action:** When working on DB optimizations, review the database access patterns using `EXPLAIN QUERY PLAN` specifically when `ORDER BY` or `GROUP BY` are involved, and remember that SQLite can optimize away a sorting step if a composite index matches both the filtering columns and the sort columns in order.
