-- Eighth change to D1 "wvwrelink", after schema-007-notes.sql. Eight statements,
-- one per Execute in the console. Without the columns the readers' messages still
-- go in and /api/latest answers, without `taken` (Workers Logs: "taken": "failed").
-- What each team took this week, counted by the Worker from the readers' bodies
-- (takenNext in worker/index.mjs): the capture points and the flips of each team,
-- since the week began or since these columns came, whichever is later.
ALTER TABLE latest ADD COLUMN taken_red INTEGER;
ALTER TABLE latest ADD COLUMN taken_blue INTEGER;
ALTER TABLE latest ADD COLUMN taken_green INTEGER;
ALTER TABLE latest ADD COLUMN flips_red INTEGER;
ALTER TABLE latest ADD COLUMN flips_blue INTEGER;
ALTER TABLE latest ADD COLUMN flips_green INTEGER;
-- Each map's flips of the last two hours, epoch s by the Worker's clock: {"<map id>": [t, ...]}.
ALTER TABLE latest ADD COLUMN flip_times TEXT;
-- Each counted objective of the stored body as [id, team (0 red, 1 blue, 2 green, -1 none),
-- capture value]: what the next body is compared with, without parsing the stored one.
ALTER TABLE latest ADD COLUMN owners TEXT;
