-- Third change to D1 "wvwrelink", after schema-002-recent.sql. Run in the D1
-- console ONE STATEMENT PER EXECUTE, BEFORE the Worker code that needs it merges.
-- For the "latest" entrance: outside readers push each match's newest game-API
-- body, GET /api/latest gives them to the page.

-- The newest body of each match, gzip as base64 (text: D1 and node:sqlite hand
-- BLOBs back differently, and the read goes straight into JSON). The Worker never
-- opens it. at = epoch seconds by the Worker's clock when it was accepted.
CREATE TABLE latest (id TEXT PRIMARY KEY, start INTEGER NOT NULL, score INTEGER NOT NULL, at INTEGER NOT NULL, reader TEXT NOT NULL, gz TEXT NOT NULL, sha TEXT NOT NULL, raw INTEGER NOT NULL) WITHOUT ROWID;

-- The match's score sum when the row was written; NULL on the sheet's older rows.
ALTER TABLE kills ADD COLUMN score INTEGER;

-- One replay clock per reader.
INSERT INTO source (name, t, received) VALUES ('latest-supa-us', 0, 0), ('latest-supa-eu', 0, 0), ('latest-vercel-eu', 0, 0), ('latest-vercel-us', 0, 0);
