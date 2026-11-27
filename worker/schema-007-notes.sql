-- Seventh change to D1 "wvwrelink", after schema-006-history.sql. Five statements,
-- one Execute each in the console, before the code that reads them merges.
-- The game's update notes (worker/notes.mjs): what the wiki's readings held, and
-- what GET /api/notes serves.
CREATE TABLE note_group (
  note    TEXT    PRIMARY KEY,  -- the wiki's h2, 'Update - November 10, 2026'
  day     TEXT    NOT NULL,     -- its date, '2026-11-10'
  page    TEXT    NOT NULL,     -- the wiki page it sits on, Game_updates/<page>
  hotfix  INTEGER NOT NULL      -- 1 but for a release's own heading (worker/notes.mjs)
) WITHOUT ROWID;
CREATE TABLE note_line (
  note    TEXT    NOT NULL,     -- note_group.note
  id      TEXT    NOT NULL,     -- 32 hex of SHA-256 over the note and the line's fields
  pos     INTEGER NOT NULL,     -- its order in the note
  section TEXT    NOT NULL,
  sub     TEXT    NOT NULL,
  body    TEXT    NOT NULL,     -- the line, plain text, at most 300 characters
  link    TEXT,                 -- a wiki page name, checked
  kind    TEXT,                 -- its type, or NULL when the rules are not sure
  seen    INTEGER NOT NULL,     -- epoch s of the first reading in the run of readings that had it
  last    INTEGER NOT NULL,     -- epoch s of the latest reading that had it (a hotfix's, until it is due)
  PRIMARY KEY (note, id)
) WITHOUT ROWID;
CREATE TABLE note_served (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  push    TEXT    NOT NULL,     -- 16 hex of the last accepted push: the same one again writes no line
  wiki    INTEGER NOT NULL,     -- epoch s of the last accepted wiki reading, 0 never
  version TEXT    NOT NULL,     -- 16 hex of body: GET /api/notes?v=
  body    TEXT    NOT NULL,     -- the published lines, JSON
  ripe    INTEGER NOT NULL      -- epoch s when a hotfix's line left out of body is due, 0 none
);
INSERT INTO note_served (id, push, wiki, version, body, ripe) VALUES (1, '', 0, '', '[]', 0);
-- The notes script's replay guard (POST /api/ingest/notes), also in /api/health.
INSERT INTO source (name, t, received) VALUES ('notes', 0, 0);
