-- Third change to D1 "wvwrelink", after schema-002-recent.sql. Run in the D1
-- console ONE STATEMENT PER EXECUTE, BEFORE the Worker code that needs it merges.
-- For the "agora" entrance: outside readers push each match's newest game-API
-- body, GET /api/agora gives them to the page.

-- The newest body of each match, gzip as base64 (text: D1 and node:sqlite hand
-- BLOBs back differently, and the read goes straight into JSON). The Worker never
-- opens it. at = epoch seconds by the Worker's clock when it was accepted.
CREATE TABLE agora (id TEXT PRIMARY KEY, start INTEGER NOT NULL, score INTEGER NOT NULL, at INTEGER NOT NULL, leitor TEXT NOT NULL, gz TEXT NOT NULL, sha TEXT NOT NULL, raw INTEGER NOT NULL) WITHOUT ROWID;

-- The match's score sum when the row was written; NULL on the sheet's older rows.
ALTER TABLE kills ADD COLUMN score INTEGER;

-- One replay clock per reader.
INSERT INTO source (name, t, received) VALUES ('agora-supa-us', 0, 0), ('agora-supa-eu', 0, 0), ('agora-vercel-eu', 0, 0), ('agora-vercel-us', 0, 0);
