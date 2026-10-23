# en-agent

Read README.md for the launcher, bundle layout and release workflow. Before changing shipped launcher code, instructions or bundled components, or preparing an update/install/release, read [VERSIONING.md](VERSIONING.md). Classify the version impact and apply the required bump before distributing changed artifacts.

Preserve configuration isolation, authorization, user data and game files during updates. Use synthetic games for mutation tests. Commit, push, publish and installation require an explicit user request.
