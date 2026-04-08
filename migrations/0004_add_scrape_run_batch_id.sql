ALTER TABLE scrape_runs ADD COLUMN batch_id TEXT;

WITH ordered AS (
  SELECT
    id,
    started_at,
    COALESCE(finished_at, started_at) AS finished_or_started_at,
    LAG(COALESCE(finished_at, started_at)) OVER (ORDER BY started_at) AS prev_finished_or_started_at
  FROM scrape_runs
),
grouped AS (
  SELECT
    id,
    started_at,
    SUM(
      CASE
        WHEN prev_finished_or_started_at IS NULL THEN 1
        WHEN unixepoch(started_at) > unixepoch(prev_finished_or_started_at) + 900 THEN 1
        ELSE 0
      END
    ) OVER (ORDER BY started_at ROWS UNBOUNDED PRECEDING) AS grp
  FROM ordered
),
batched AS (
  SELECT
    id,
    'legacy-' || MIN(started_at) OVER (PARTITION BY grp) AS derived_batch_id
  FROM grouped
)
UPDATE scrape_runs
SET batch_id = (
  SELECT derived_batch_id
  FROM batched
  WHERE batched.id = scrape_runs.id
)
WHERE batch_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_runs_batch_started
  ON scrape_runs(batch_id, started_at DESC);
