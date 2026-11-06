# Conventional IDE tooling

The spatial app uses maintained Theia 1.74.3 modules plus VS Code-compatible extensions. It does not use the retired `@theia/git` package. Physical agent screens and the existing read-only task review remain separate from the conventional SCM UI.

## Reproducible setup

Use Node 22+, Python 3 and the native prerequisites in SETUP.md. From `omo`:

```sh
npm ci --ignore-scripts
npm rebuild drivelist @vscode/ripgrep --foreground-scripts
npm run build
npm run check:ide
npm start -- --workspace /absolute/path/to/your/project
```

`build` explicitly prepares the pinned extensions. The first preparation downloads public artifacts from the Eclipse Theia release and Open VSX, checks their SHA-256 values and expands their VSIX payloads into system-plugin package directories. A directory of raw VSIX files is not a valid Theia system-plugin installation. All artifact versions, source URLs, checksums and download limits are in `ide-extensions.lock.json`. Registry redirects are limited to the observed GitHub/Eclipse asset hosts. No extension installer or package script is executed by the archive extractor.

The builtin bundle includes Git/Git Base, JavaScript/TypeScript language support and the JavaScript debugger. Python, Pyright and the Linux x64 Python debugger are separately pinned. Unsupported debugger platforms are reported rather than silently certified. The normal workspace trust prompt remains enabled. Agent trust, authentication and tool approvals are unchanged.

`check:ide` is an offline filesystem/hash check. It does not download, start services, run tools, inspect provider credentials or contact agents. Normal app startup also does not download missing extensions: it gives the explicit preparation instruction instead. The bundled directory is an immutable, canonical source bundle. At each boot the launcher verifies its complete manifest and SHA-256 tree, creates a new owned temporary plugin copy below the selected `THEIA_CONFIG_DIR`, copies only the pinned files and metadata, verifies that copy, and passes only that path to Theia. Debugger IPC and Python bytecode can therefore be written only to the disposable copy. A failed copy or unsafe ownership is left for inspection; cleanup never traverses or removes another cache, extension store, global storage or adjacent directory. The installer does not remove an unknown source bundle automatically. Stop the app and inspect it before replacing an owned bundle.

The app passes only its new private copy to the extension host. It does not inherit parent `THEIA_PLUGINS`, `THEIA_DEFAULT_PLUGINS` or Hermes conversation-routing identity. User extension state uses the selected Theia configuration directory and persists separately from the disposable plugin copy. `PYTHONDONTWRITEBYTECODE=1` is set for the backend. No personal credentials are embedded in the bundle.

## Verified real-app paths

Run after the build:

```sh
node extension/test/ide-tooling-real-app.cjs
```

This creates an owned disposable Git project, private app/config/profile, and explicit no-network recorder pins for all three agent kinds. It then uses the actual Theia UI to:

- Stage the changed file through `Git: Stage All Changes` and verify the real Git index.
- Enter an SCM message and commit; verify the new commit, exact message and clean worktree.
- Launch the actual JavaScript debugger, observe its paused call stack before the program writes anything, then continue and verify the program's output file.
- Select the actual Python debugpy configuration, observe its paused entry/call stack, then continue and verify its output file.
- Verify that no agent was launched and no Git remote was configured.

The test is registered in the local CI-equivalent browser suite. It does not push, merge, contact a paid model, or prove every marketplace extension, language server, operating system or provider account. Python/debugpy runtime proof is Linux x64. English UI is used in the fixture; upstream Python packages currently log missing optional localization directories. Those logs do not establish translated-language support. Whole-product acceptance is a separate gate.
