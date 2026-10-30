-- Fifth change to D1 "wvwrelink", after schema-004-drop-vercel-sources.sql. One
-- statement, one Execute in the console, BEFORE the Worker code that writes it
-- merges (without the table the readers' messages still go in; only this write
-- fails, and Workers Logs says "board": "failed").
-- Each match's skirmishes, from the readers' summaries (acceptLatest): one row
-- per skirmish once it has finished, and the week's last while it runs. Kept
-- for good: the daily cleanup deletes kills only.
CREATE TABLE board (
  match    TEXT    NOT NULL,     -- '1-1' .. '2-9'
  start    INTEGER NOT NULL,     -- the match's start_time, epoch ms
  skirmish INTEGER NOT NULL,     -- 1 .. 84
  red      INTEGER NOT NULL,     -- the skirmish's score of each team: final, or
  blue     INTEGER NOT NULL,     -- the highest read of the week's last
  green    INTEGER NOT NULL,
  vp_red   INTEGER NOT NULL,     -- the match's victory_points after it, the
  vp_blue  INTEGER NOT NULL,     -- highest read while it was the last finished;
  vp_green INTEGER NOT NULL,     -- for the week's last, the VP before it
  at       INTEGER NOT NULL,     -- epoch ms by the Worker's clock, last written
  PRIMARY KEY (match, start, skirmish)
) WITHOUT ROWID;
