# Zen Organizer

Zen Organizer is a privacy-first Sine mod for reviewing and organizing every live Zen Space, Folder, and tab from one page. It supports local search, filtering, exact-duplicate and inactivity views, reviewed bulk plans, and optional Ollama or OpenAI-compatible planning.

Nothing changes Zen until you review and approve a plan. Closing tabs has a second confirmation. AI is optional; `none` mode is the default and makes no network request.

## Status and compatibility

Version 0.1.0 is a release candidate.

| Zen version | Build ID | Inventory | Mutations |
|---|---:|---|---|
| 1.21.15b | `20260818101929` | Verified | Verified |
| Any other build | Any | Feature-detected | Disabled until verified |

Zen Organizer uses Zen-private APIs. Unknown builds fail closed: inventory remains available when its APIs are present, while mutation controls are disabled. See [the release checklist](docs/release-checklist.md) for the exact test evidence and remaining release gate.

## Install with Sine

1. Install [Sine](https://github.com/CosmoCreeper/Sine/releases/latest) and restart Zen.
2. Open Zen Settings, then Sine Mods.
3. Open Sine's settings and enable **Enable installing JS from unofficial sources**.
4. In the custom-mod field, enter `jorgerdz/zen-zest` and install it.
5. Restart Zen, then choose **Tools → Zen Organizer**.

The repository must be publicly reachable before Sine can install it by name. The release zip is a versioned source/review artifact, not a standalone Sine installer.

## Use

1. Search or filter the inventory and select tabs.
2. Stage moves, Folder changes, pin changes, or closes.
3. Edit or remove operations in Draft plan.
4. Choose **Review and apply**, inspect the confirmation, and approve it.

Zen Organizer refreshes immediately before apply. If Zen changed since the plan was created, the plan is marked stale and nothing runs. Execution stops on the first failure and reports completed, failed, and not-run actions.

## Optional providers

- **None:** fully local; no request can run.
- **Ollama:** use a loopback origin such as `http://127.0.0.1:11434` and a locally installed model name.
- **OpenAI-compatible:** enter the service origin and model. Loopback HTTP is allowed; private-LAN HTTP requires an extra warning; public endpoints require HTTPS.

Before the first request, the app shows the exact outbound JSON and requires consent. Tokens use Firefox Login Manager when available and otherwise remain only in memory for the current session.

## Privacy

Local analysis may inspect full tab URLs in memory to find exact duplicates. Provider disclosure is limited to the user prompt plus tab titles, non-local hostnames, hierarchy names and IDs, pinned/Essential state, and coarse last-selected age. It excludes URL paths, queries, fragments, page content, container names, and local hostnames.

There is no telemetry, remote logging, background cleanup, inbound listener, or direct write to Zen session/profile files. Provider redirects are rejected and model output must pass the same local plan validator as manual plans.

## Clear data, recovery, and removal

**Clear organizer data** removes the saved draft, settings, consent, last result, and organizer-owned Login Manager credentials. It does not touch tabs, Spaces, or Folders.

After a partial failure, refresh and make a new plan for the remaining work. Desired-state operations are safe to retry. A separately confirmed close can be recovered with Zen's **Undo Close Tab**. Removing the mod does not undo already approved Zen changes.

To uninstall, remove or disable Zen Organizer in Sine and restart Zen. Use **Clear organizer data** first if you also want its saved settings and credentials removed.

## Verify source

```sh
node --test tests/*.test.mjs
shasum -a 256 release/zen-organizer-0.1.0.zip
```

No dependency install or build step is required.

## License

[MIT](LICENSE)
