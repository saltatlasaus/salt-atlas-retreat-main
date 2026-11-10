-- How many times the Worker has tried a photo. Refused photos (some resort sites block Cloudflare's servers)
-- are retried on the next mornings' 06:30 runs, up to 3 tries; then tools/fetch_failed_photos.py on a
-- computer with internet can fetch them. Applied to live D1.
ALTER TABLE photo_mirror ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
