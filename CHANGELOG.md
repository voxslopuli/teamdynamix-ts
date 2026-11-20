## v0.3.2 - 2026-11-20

- fix: runtime schema validation no longer throws per call when a route's published schema cannot compile — the live API publishes `FeedItemType` with duplicate alias values ("Ticket Task"/"Maintenance Activity" both 25), which made Ajv reject the feed-route response schema and killed every `get_ticket_feed` call under fail-closed validation (#22 symptom 1). Uncompilable schemas are now skipped with a one-time stderr warning
- fix: spec regeneration dedupes enum value arrays in the live doc (2 duplicates removed) so the shipped spec compiles cleanly
- verified: path-prefixed base URLs (e.g. `https://host/TDWebApi`) join correctly in the SDK client — regression test added with the route reaching `.../TDWebApi/api/{appId}/tickets/search`

**Full Changelog**: https://github.com/voxslopuli/teamdynamix-ts/compare/v0.3.1...v0.3.2

## v0.3.0 - 2026-11-18

- feat: SDK regenerated from the live deployment OpenAPI spec (#13) — 256 new operations, 74 removed, 322 preserved with byte-identical method names
- **BREAKING:** the legacy `/api/projects/*` SDLC namespace is removed (the live API moved it under `/api/{appId}/projects/*`); `POST/DELETE /api/{appId}/assets/{assetId}/users/{resourceID}` also removed
- 5 seldom-used DELETE method names shifted numeric collision suffixes (e.g. `appIdKnowledgebaseId3` → `appIdKnowledgebaseId4`)
- spec sanitizer documents/applies the live-spec quirk fixes required for type generation (invalid `nullable`, parameter-level defaults, path/parameter name mismatches)

**Full Changelog**: https://github.com/voxslopuli/teamdynamix-ts/compare/v0.2.1...v0.3.0

## v0.2.1 - 2026-10-28

**Full Changelog**: https://github.com/voxslopuli/teamdynamix-ts/compare/v0.1.5...v0.2.1

## v0.1.5 - 2026-09-14

**Full Changelog**: https://github.com/selfagency/teamdynamix-ts/compare/v0.1.4...v0.1.5

# Changelog

## v0.1.4 - 2026-09-11

## What's Changed
* fix: ship generated openapi.json in published dist tarball by @selfagency in https://github.com/selfagency/teamdynamix-ts/pull/12


**Full Changelog**: https://github.com/selfagency/teamdynamix-ts/compare/v0.1.3...v0.1.4

