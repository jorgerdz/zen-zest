# Zen Organizer 0.1.0 — Release Checklist

**Status:** Source hardening complete; public release held for a genuine fresh-profile Sine install smoke test  
**Verified:** 2026-08-29  
**Test profile:** `/tmp/zen-zest-persist-profile-20260828` only

## Compatibility

| Zen | Build ID | Result |
|---|---:|---|
| 1.21.15b | `20260818101929` | Read and mutation paths pass |
| Other builds | Any | Read APIs are feature-detected; all mutations fail closed |

The installed build is both the minimum and current build available for this release check. Compatibility is keyed to the exact version and build ID, not a version range.

## Evidence

| Gate | Result | Evidence |
|---|---|---|
| Native regression suite | Pass | 23/23 `node:test` checks |
| Private API boundary | Pass | Release test permits Zen internals only in `zen-adapter.mjs` |
| Network boundary | Pass | Release test permits `fetch` only in `providers.mjs`; provider cannot import the adapter |
| Inventory/render | Pass | Earlier 500-tab/100-Folder snapshot plus render: 18 ms; observed wall time: 35 ms |
| Search/filter | Pass | Earlier 500-tab search/filter render: 4.85 ms |
| Reviewed bulk apply | Pass | 50 tab moves plus one Folder creation: 51/51 actions in 60 ms |
| Restart/no tab loss | Pass | All 51 starting stable tab IDs remained after apply and restart; all 50 destinations persisted |
| Drift and partial failure | Pass | Regression tests prove zero mutation on drift and exact completed/failed/not-run reporting |
| Providers | Pass | `none` zero-network test, real Ollama plan, fake OpenAI-compatible UI flow, strict output validation |
| Consent and storage | Pass | Exact preview precedes consent; Login Manager save/load/remove passed |
| Clear organizer data | Pass | Draft/settings and one smoke credential removed; Zen counts and revision unchanged |
| Narrow reflow | Pass | 396 CSS-pixel viewport had no page overflow |
| Accessibility basics | Pass | Semantic landmarks, labeled fields, 44px controls, solid 3px focus, non-color status, reduced motion, WCAG AA palette contrast |
| Session-file safety | Pass | Static boundary check plus all live mutations used Zen APIs |
| Package contents/checksum | Pass | Archive integrity check passed; SHA-256 sidecar is present |
| Packaged lifecycle | Pass | Extracted archive registered its chrome manifest, loaded the `.uc.mjs`, added the Tools menu item, opened the organizer page, and removed the item on unload |
| Fresh Sine install | **Pending** | Sine is not installed on this machine; source loader behavior was inspected only |

The performance fixture used 500 tabs and 100 Folders across two Spaces, which exceeds the tab and Folder targets but not the requested 10-Space topology. The full 50-tab apply/restart proof began with 51 tabs. Re-run the exact 300-tab/10-Space/20-Folder topology if certification requires literal fixture parity.

## Release resolution

- The source is hardened and suitable for local review.
- Do not label 0.1.0 a verified public Sine release until the packaged repository installs through Sine in a fresh disposable Zen profile and the menu/page smoke test passes.
- A failure on another Zen build leaves the organizer read-only; add that exact build only after repeating the compatibility and mutation suite.
