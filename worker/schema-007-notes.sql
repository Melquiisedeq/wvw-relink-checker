-- Seventh change to D1 "wvwrelink", after schema-006-history.sql. Six statements,
-- one Execute each in the console, before the code that reads them merges.
-- The game's update notes (worker/notes.mjs): what the wiki's last readings held,
-- which days the forum's RSS has, and what GET /api/notes serves.
CREATE TABLE note_group (
  note    TEXT    PRIMARY KEY,  -- the wiki's h2, 'Update - November 10, 2026'
  day     TEXT    NOT NULL,     -- its date, '2026-11-10'
  page    TEXT    NOT NULL,     -- the wiki page it sits on, Game_updates/<page>
  n       INTEGER NOT NULL,     -- lines kept from its last accepted reading
  seen    INTEGER NOT NULL,     -- epoch s of the last reading that had it, while current = 0
  current INTEGER NOT NULL      -- 1: the last accepted reading had it (its time is note_feed.wiki)
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
  first   INTEGER NOT NULL,     -- epoch s of the first reading that had it, unchanged since
  rss     INTEGER NOT NULL,     -- 0 not yet checked, 1 its day's RSS item holds its text, -1 it does not
  PRIMARY KEY (note, id)
) WITHOUT ROWID;
CREATE TABLE note_day (
  day TEXT PRIMARY KEY          -- a day the forum's RSS has release notes for
) WITHOUT ROWID;
CREATE TABLE note_feed (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  push    TEXT    NOT NULL,     -- 16 hex of the last accepted push: the same one again writes no line
  wiki    INTEGER NOT NULL,     -- epoch s of the last accepted wiki reading, 0 never
  rss     INTEGER NOT NULL,     -- epoch s of the last RSS read with items, 0 never
  version TEXT    NOT NULL,     -- 16 hex of body: GET /api/notes?v=
  body    TEXT    NOT NULL      -- the published lines, JSON
);
INSERT INTO note_feed (id, push, wiki, rss, version, body) VALUES (1, '', 0, 0, '', '[]');
-- The notes script's replay guard (POST /api/ingest/notes), also in /api/health.
INSERT INTO source (name, t, received) VALUES ('notes', 0, 0);
