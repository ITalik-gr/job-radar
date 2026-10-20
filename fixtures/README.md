# Fixtures

Saved source responses for adapter smoke tests.

The rule from CLAUDE.md: an adapter without a test on a fixture is not done.

Naming: `<source>/<description>.<json|html>`, for example `greenhouse/acme-jobs.json`.
The test that uses a fixture also pins the minimum number of records it must yield.
Zero records in a test means the parser broke.
