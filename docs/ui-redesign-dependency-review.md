# Dependency review for the UI release

The production dependency scan exposed two upstream advisories during the UI release verification:

- `follow-redirects` 1.16.1 is replaced in the lockfile by patched 1.16.2. [Upstream advisory](https://github.com/advisories/GHSA-mrwp-f3q8-3g9p).
- `readdir-glob` now uses the scoped `minimatch` 11.0.1 override. Its named `Minimatch` constructor and Node 24 support remain compatible with the archive dependency. [Upstream advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249).

The application creates ZIPs from explicit sanitized entries with `ZipArchive.append`, rather than user-supplied glob patterns. The archive integration test nevertheless exercises real ZIP creation, downloading and byte signatures after this dependency update.

Validation: all 119 backend tests pass, including ZIP generation, protected reader, workflow gates, provider outcomes and notification tests. `npm audit --omit=dev` reports zero vulnerabilities. The development-only nodemon/minimatch chain still reports two moderate audit entries; it is not part of the production dependency set.

This adds one separately reviewable dependency-fix commit to the planned UI release sequence. No production API route, payload, schema, permission or notification-template change is included, and no migration is required.
