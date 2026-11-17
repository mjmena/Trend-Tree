-- Generate with build_editorial_nomination_signals_fixture.py and run in an isolated schema.
-- The projection reads temporary receipts only; no signal or trend tables exist here.
CREATE OR REPLACE TEMPORARY TABLE _EDITORIAL_NOMINATIONS_FIXTURE (
  NOMINATION_ID VARCHAR,
  REQUEST VARIANT,
  DROPPED_URLS VARIANT,
  STATUS VARCHAR,
  RESULT VARIANT,
  CREATED_AT TIMESTAMP_NTZ,
  UPDATED_AT TIMESTAMP_NTZ
);

INSERT INTO _EDITORIAL_NOMINATIONS_FIXTURE
SELECT column1, PARSE_JSON(column2), PARSE_JSON(column3), column4,
       PARSE_JSON(column5), column6::TIMESTAMP_NTZ, column7::TIMESTAMP_NTZ
FROM VALUES
  ('nomination-a',
   '{"brief":"private brief","nominated_by":"private@example.test","urls":[{"url":"https://example.test/shared?utm_source=first","canonical":"https://example.test/shared","title":"Shared story"},{"url":"https://example.test/shared?utm_source=second","canonical":"https://example.test/shared","title":"Shared story"},{"url":"https://example.test/second","canonical":"https://example.test/second","title":"Second story"}]}',
   '[{"url":"https://example.test/dropped","reason":"dead_404"}]',
   'created', '{"trend_id":"trend-new","error":null}',
   '2026-11-17 10:00:00', '2026-11-17 10:01:00'),
  ('nomination-b',
   '{"brief":"another private brief","nominated_by":"another@example.test","urls":[{"url":"https://example.test/shared","canonical":"https://example.test/shared","title":null,"unverified":true}]}',
   '[]', 'pending', '{"trend_id":null,"error":null}',
   '2026-11-17 11:00:00', '2026-11-17 11:00:30'),
  ('nomination-c',
   '{"brief":"partial completion","nominated_by":"private@example.test","urls":[{"url":"https://example.test/partial","canonical":"https://example.test/partial"}]}',
   '[]', 'failed', '{"trend_id":"trend-partial","error":{"code":"incomplete"}}',
   '2026-11-17 12:00:00', '2026-11-17 12:01:00');

-- VIEW_UNDER_TEST

CREATE OR REPLACE TEMPORARY TABLE _EDITORIAL_NOMINATION_EXPECTED (
  NOMINATION_ID VARCHAR,
  SIGNAL_ID VARCHAR,
  STATUS VARCHAR,
  TREND_ID VARCHAR,
  ACCEPTED_AT TIMESTAMP_NTZ
) AS
SELECT column1, column2, column3, column4, column5::TIMESTAMP_NTZ
FROM VALUES
  ('nomination-a', 'https://example.test/shared', 'created', 'trend-new', '2026-11-17 10:00:00'),
  ('nomination-a', 'https://example.test/second', 'created', 'trend-new', '2026-11-17 10:00:00'),
  ('nomination-b', 'https://example.test/shared', 'pending', NULL, '2026-11-17 11:00:00'),
  ('nomination-c', 'https://example.test/partial', 'failed', 'trend-partial', '2026-11-17 12:00:00');

CREATE OR REPLACE TEMPORARY TABLE _EDITORIAL_NOMINATION_CHECKS AS
SELECT 'each accepted nomination retains its kept canonical URLs and current result' AS CHECK_NAME,
       NOT EXISTS (
         SELECT NOMINATION_ID, SIGNAL_ID, STATUS, TREND_ID, ACCEPTED_AT
         FROM _EDITORIAL_NOMINATION_SIGNALS_FIXTURE
         MINUS
         SELECT * FROM _EDITORIAL_NOMINATION_EXPECTED
       ) AND NOT EXISTS (
         SELECT * FROM _EDITORIAL_NOMINATION_EXPECTED
         MINUS
         SELECT NOMINATION_ID, SIGNAL_ID, STATUS, TREND_ID, ACCEPTED_AT
         FROM _EDITORIAL_NOMINATION_SIGNALS_FIXTURE
       ) AS PASS
UNION ALL
SELECT 'duplicate canonical URLs collapse within one nomination, not across nominations',
       (SELECT COUNT(*) FROM _EDITORIAL_NOMINATION_SIGNALS_FIXTURE) = 4
UNION ALL
SELECT 'only the five public columns are exposed',
       (SELECT LISTAGG(COLUMN_NAME, ',') WITHIN GROUP (ORDER BY ORDINAL_POSITION)
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = CURRENT_SCHEMA()
          AND TABLE_NAME = '_EDITORIAL_NOMINATION_SIGNALS_FIXTURE')
       = 'NOMINATION_ID,SIGNAL_ID,STATUS,TREND_ID,ACCEPTED_AT';

UPDATE _EDITORIAL_NOMINATIONS_FIXTURE
SET STATUS = 'merged', RESULT = PARSE_JSON('{"trend_id":"trend-existing","error":null}'),
    UPDATED_AT = '2026-11-17 11:02:00'::TIMESTAMP_NTZ
WHERE NOMINATION_ID = 'nomination-b';

INSERT INTO _EDITORIAL_NOMINATION_CHECKS
SELECT 'a completed result changes status and target while preserving acceptance time',
       (SELECT COUNT(*) FROM _EDITORIAL_NOMINATION_SIGNALS_FIXTURE
        WHERE NOMINATION_ID = 'nomination-b' AND SIGNAL_ID = 'https://example.test/shared'
          AND STATUS = 'merged' AND TREND_ID = 'trend-existing'
          AND ACCEPTED_AT = '2026-11-17 11:00:00'::TIMESTAMP_NTZ) = 1;

SELECT CHECK_NAME, PASS FROM _EDITORIAL_NOMINATION_CHECKS ORDER BY CHECK_NAME;

SELECT 1 / IFF(COUNT_IF(NOT PASS OR PASS IS NULL) = 0, 1, 0) AS ALL_CHECKS_PASSED
FROM _EDITORIAL_NOMINATION_CHECKS;
