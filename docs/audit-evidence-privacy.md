# Audit evidence privacy

This repository is public. Keep production-derived records, aggregates, profiles,
reviewer responses, screenshots and run logs in a private location. Use the
gitignored `analysis_output/audit/` tree for local work; it is not a backup service.
Public examples must be synthetic and clearly identified as such. Review source
comments and generated reports as well as structured exports before publication.

The audit runner reads its default bundle from
`analysis_output/audit/stats-bundle/` and writes responses and dry-run prompt dumps
under `analysis_output/audit/responses/`. External model calls still require an
explicit `--fire`; review the complete bundle and its destination before using it.
Do not restore removed evidence into `audit/` or force-add ignored output.

The monthly workflow's uploaded artifact contains only its two generated
operational metadata files. Never upload the containing directory or include
health data in an Actions artifact, log, issue, pull request or review bundle.

Removing a file from the current tree does not remove earlier commits, caches,
forks, downloads or artifacts. Historical cleanup needs a separate, reviewed
path/ref inventory, a verified private recovery copy and explicit authorization.
Do not force-push or delete hosted artifacts as part of ordinary file cleanup.
Recovery must preserve private originals without republishing them.
