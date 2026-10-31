-- Sixth change to D1 "wvwrelink", after schema-005-board.sql. One statement,
-- one Execute in the console. Without the table the readers' messages still go
-- in; only this write fails (Workers Logs: "history": "failed"), the summary
-- carries no `hist`, and GET /api/history answers 503.
-- Each match's finished skirmishes, from the readers' format 2 (acceptLatest):
-- only the newest version, the week and the count it was sent at.
-- GET /api/history/<region>?v=<n> serves it.
CREATE TABLE history (
  match TEXT    PRIMARY KEY,   -- '1-1' .. '2-9'
  start INTEGER NOT NULL,      -- the match's start_time, epoch ms
  n     INTEGER NOT NULL,      -- finished skirmishes held, 1 .. 84
  at    INTEGER NOT NULL,      -- epoch s by the Worker's clock, last written
  body  TEXT    NOT NULL       -- the game API's skirmishes 1 .. n, as JSON
) WITHOUT ROWID;
