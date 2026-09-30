-- The database behind wvwrelink.com/api, D1 "wvwrelink". Run in the D1
-- console ONE STATEMENT PER EXECUTE: given the whole file it ran only the last
-- one and said "Executed 1/1" (30/09/2026). A change to it is a new file of
-- statements, run the same way.

-- The last accepted message from each script, by the time it signed. A message
-- signed at or before this one is a replay and is refused.
CREATE TABLE source (
  name     TEXT PRIMARY KEY,
  t        INTEGER NOT NULL,   -- epoch seconds, as signed
  received INTEGER NOT NULL    -- epoch seconds, by the Worker's clock
);
INSERT INTO source (name, t, received) VALUES ('kills', 0, 0), ('relink', 0, 0);

-- apps-script/kills/kills.gs, one row per match per tick, after its rules:
-- kills summed over the three teams, per map.
CREATE TABLE kills (
  match  TEXT    NOT NULL,       -- '1-1' .. '2-9'
  at     INTEGER NOT NULL,       -- epoch ms of the tick
  center INTEGER NOT NULL,
  red    INTEGER NOT NULL,       -- RedHome
  blue   INTEGER NOT NULL,       -- BlueHome
  green  INTEGER NOT NULL,       -- GreenHome
  start  INTEGER NOT NULL,       -- the match's start_time, epoch ms
  PRIMARY KEY (match, at)
) WITHOUT ROWID;

-- apps-script/relink-notice/relink-notice.gs: a copy of relink!A1 and A2 after
-- every tick. One row.
CREATE TABLE relink (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  beat      INTEGER NOT NULL,    -- A2, epoch seconds
  window_at INTEGER,             -- A1 before the colon; NULL if A1 does not parse
  published INTEGER,             -- A1 after the colon
  fails     INTEGER NOT NULL
);
