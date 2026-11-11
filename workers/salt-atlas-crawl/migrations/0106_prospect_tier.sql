-- Two tiers of partner (Kieran, 11 Nov 2026):
--   premium: fit score 7.0+ (high-ticket surf resorts and charters)
--   atlas:   6.0-6.9 but standout in its own right (outstanding reviews or a world-class wave),
--            never cheap; built after premium, to give the atlas its breadth.
ALTER TABLE prospects ADD COLUMN tier TEXT CHECK (tier IN ('premium', 'atlas'));
UPDATE prospects SET tier = 'premium' WHERE fit_score >= 7.0;
