-- Fourth change to D1 "wvwrelink", after schema-003-latest.sql. Run in the D1
-- console, one Execute, AFTER the Worker code that stops accepting these two
-- sources merges (until then /api/health lists them).
-- The Vercel readers were never deployed; their replay clocks go.
DELETE FROM source WHERE name IN ('latest-vercel-eu', 'latest-vercel-us');
