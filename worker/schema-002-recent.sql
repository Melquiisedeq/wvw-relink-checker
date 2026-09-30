-- Second change to D1 "wvwrelink", after schema.sql. One statement, one
-- Execute in the console. Created before the Worker code that writes it merges.

-- The last 30 minutes of kills, rebuilt by every kills message and read by
-- GET /api/kills. One row, so a read costs one row of D1's 5 million a day
-- whatever it asks: a query over the kills table would cost ~60, and reading
-- it by time alone scans all of it (36,288 rows at 14 days) - ~140 requests
-- would stop the database, writes included, until 00:00 UTC.
CREATE TABLE recent (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL, rows TEXT NOT NULL);
