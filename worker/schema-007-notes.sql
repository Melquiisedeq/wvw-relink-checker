-- Seventh change to D1 "wvwrelink", after schema-006-history.sql. Five statements,
-- one Execute each in the console, before the code that reads them merges.
-- The game's update notes (worker/notes.mjs): what the wiki's readings held, and
-- what GET /api/notes serves.
CREATE TABLE note_group (
  note    TEXT    PRIMARY KEY,  -- the wiki's h2, 'Update - November 10, 2026'
  day     TEXT    NOT NULL,     -- its date, '2026-11-10'
  page    TEXT    NOT NULL,     -- the wiki page it sits on, Game_updates/<page>
  n       INTEGER NOT NULL,     -- lines kept from its last accepted reading
  top     INTEGER NOT NULL,     -- the floor's measure: the most lines two readings in a row had
  last    INTEGER NOT NULL      -- lines the last reading of its page had, 0 when it lacked the note
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
  PRIMARY KEY (note, id)
) WITHOUT ROWID;
CREATE TABLE note_served (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  push    TEXT    NOT NULL,     -- 16 hex of the last accepted push: the same one again writes no line
  wiki    INTEGER NOT NULL,     -- epoch s of the last accepted wiki reading, 0 never
  version TEXT    NOT NULL,     -- 16 hex of body: GET /api/notes?v=
  body    TEXT    NOT NULL      -- the published lines, JSON
);
INSERT INTO note_served (id, push, wiki, version, body) VALUES (1, '', 0, '', '[]');
-- The notes script's replay guard (POST /api/ingest/notes), also in /api/health.
INSERT INTO source (name, t, received) VALUES ('notes', 0, 0);
