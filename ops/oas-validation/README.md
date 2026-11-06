# AHI operator validation tooling

This tooling branch distributes the existing reconciliation audit without a ZIP.
It does not change main, Worker code, production configuration or migrations.

`operator_validate.py`:
- Requires the exact reviewed source commit and migration hashes.
- Requires the exact operator-verified backup checksum before querying anything.
- Uses the captured JSON, supplementing incomplete metadata using SELECT only.
- Uses existing Wrangler 4.158.0 authentication. Native Node invocation avoids
  Windows .cmd quoting/percent-expansion hazards for SQL arguments.
- Performs only hard-coded production SELECT/PRAGMA reads, including live pause,
  cap, history, counts, quick_check and foreign-key checks.
- Imports `audit.py` for schema comparison and local-only backup rehearsal.
- Stops on schema differences, checksum failures, integrity/FK errors or drift.
- Never runs test_plan.py or repeats synthetic test fixtures.
- Prints no customer rows, emails, tokens, OAuth material or full binding dumps.
- Prints proposed baseline/migration/deployment commands only after success.
  It NEVER executes those write/deploy commands.

The SQL backup stays on the operator's Windows computer. A restored SQLite copy
contains customer records and must remain private; paste only SANITIZED-REPORT
output. All output lives in a fresh directory under the user's local app data.
The tool does not alter the original backup or captured schema file.

Use Python 3 with sqlite3, Node/npm, existing Git access and Wrangler auth. The
bootstrap pins this tooling commit and never checks out or merges this branch.

## Existing-evidence mode after API failure

`offline_evidence.py` never invokes Cloudflare/Wrangler/HTTP. It accepts an
explicit attestation of the already completed backup checksum check and does not
rehash that backup. The operator must use that same unchanged file.

It reconstructs the supplied sqlite_master CREATE definitions in an empty
in-memory SQLite database and derives the structural PRAGMA metadata there.
Captured automatic-index names are checked against recreated table constraints.
If required table/index SQL is missing, it stops and prints one simple consolidated
Wrangler catalog capture command, without executing it. It does not infer that
an object is missing from production merely because a filtered capture omits it.

The actual backup is restored/migrated only in a new private local directory.
All production-schema results are explicitly snapshot/evidence-based; current
production pause, data health or authorization are not silently assumed verified.
No synthetic fixtures are rerun. No production write/deployment commands execute.
