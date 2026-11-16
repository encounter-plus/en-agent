# en-agent

Read README.md for the launcher, bundle layout and release workflow. Before changing shipped launcher code, instructions or bundled components, or preparing an update/install/release, read [VERSIONING.md](VERSIONING.md). Classify the version impact and apply the required bump before distributing changed artifacts.

Preserve configuration isolation, authorization, user data and game files during updates. Use synthetic games for mutation tests. Commit, push, publish and installation require an explicit user request.

README download links must point to `https://github.com/encounter-plus/en-agent/releases/latest`. Describe installer and ZIP names with `<version>` placeholders so the README stays valid after every release. Before finishing README or release changes, verify that README has no pinned en-agent release links or versioned download filenames. Keep exact versions in historical release notes and manifests.

Before preparing a release or a user-requested push, read the OpenCode update-check record in [docs/technical.md](docs/technical.md#проверка-обновлений-opencode). If its last successful check is at least 14 days old or missing, check the official `@opencode/cli` npm metadata and upstream release notes for the newest stable 2.x version; GitHub's generic `releases/latest` may point to 1.x. Record the check date, available version, source and compatibility status there. If the lookup fails, report it and retain the previous successful date. Report available updates; adopt them only within the authorized task by updating the build pin in `config/opencode.json` and passing the compatibility and release checks in [docs/releases.md](docs/releases.md). Keep this check task-triggered, with no scheduled polling or unattended OpenCode self-update.
