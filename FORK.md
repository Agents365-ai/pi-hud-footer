# Local fork notes

This repository is [Agents365-ai](https://github.com/Agents365-ai)'s fork of
[liao666brant/pi-hud-footer](https://github.com/liao666brant/pi-hud-footer), vendored at version
0.7.0 and extended for one machine's tooling. It is published as its own package, under its own
version line: GitHub `Agents365-ai/pi-hud-footer`, npm `@agents365-ai/pi-hud-footer` from version
1.0.0. Its own changes are MIT, like upstream, and the upstream LICENSE notice is kept. Nothing
is pushed upstream.

## Remotes

- `origin` -> `https://github.com/Agents365-ai/pi-hud-footer.git` (this fork, read and write)
- `upstream` -> `https://github.com/liao666brant/pi-hud-footer.git` (fetch only)

## Install and publish

```bash
pi install git:github.com/Agents365-ai/pi-hud-footer@v1.0.0   # from git, a tag or a commit pins it
npm login                                                     # once, npm user or org Agents365-ai
npm publish --access public                                   # publishes @agents365-ai/pi-hud-footer
pi install npm:@agents365-ai/pi-hud-footer@1.0.0              # after the npm release exists
git tag v1.1.0 && git push origin main --tags                 # tag a new fork version
```

The version line is the fork's own, so an upstream 0.8.0 never collides with a fork release.
FORK.md carries the divergence; `pi-package` stays in the keywords, which makes the npm package
eligible for the pi package gallery.

## Lineage

The vendored baseline `63d745b` is a fresh root. It holds the files of upstream 0.7.0 (`fad85bd`)
except seven root files the fork does not carry: `CONTRIBUTING.md`, `.gitignore`,
`tsconfig.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.github/workflows/publish.yml` and
`.agents/skills/release/SKILL.md`. The fork has its own `.gitignore`, `tsconfig.json` and
`pnpm-workspace.yaml` instead.

The two histories are unrelated, so `git log HEAD..upstream/main` lists the whole upstream
history and means nothing. Compare content:

```bash
git fetch upstream
git diff --stat upstream/main..HEAD   # what this fork adds
git diff --stat fad85bd 63d745b       # what the vendor copy left out
```

## Local additions, and why they stay local

| Commit | Addition | Why it stays local |
|---|---|---|
| `3c04fd5`, `f79e2e3` | tmux jobs line | Hardcodes one machine's tmux socket (`pi-agent`) and the `PI_HUD_OWNER` pane tag. `CONTRIBUTING.md` asks for a config item instead of a hardcoded preference, and the pane tag is this fork's own convention. |
| `eaac0e0` | extras line (rtk / MCP / memory) | rtk and the project memory store are local tools. The module also reads `~/.pi/agent/mcp-adapter.json`, `mcp-cache.json` and the memory store, and runs `rtk gain` and `git rev-parse`, while `CONTRIBUTING.md` asks for code that reads no arbitrary user files and stays simple to audit. |
| `db79885`, `0b366a0`, `2b87bcf` | `.gitignore`, `pnpm-workspace.yaml`, `tsconfig.json` | Fork housekeeping. `verifyDepsBeforeRun: false` protects the `node_modules` symlinks; upstream reaches the same goal with `allowBuilds` and its own lockfile. |

The only upstream-shaped fragment is the MCP server count: `pi.getMcpServers()` runs in process,
reads no file and starts no subprocess. A segment built on that call alone, without the cache
lookup and the config-file fallback, is a candidate for an upstream pull request. Everything
else encodes one machine's tooling, so it stays here.

## Taking an upstream release

1. `git fetch upstream`
2. `git diff upstream/main..HEAD --stat` to see the fork's own changes again.
3. `git merge upstream/main --allow-unrelated-histories`. Conflicts are expected in every file
   the fork touched, which the table above lists. `extensions/hud-footer/tmux-jobs.ts`,
   `extensions/hud-footer/extras.ts` and this file never conflict.
4. Resolve in favour of upstream for the vendored code and documentation, then re-apply the
   fork's parts. They are marked `local fork addition` in the commit messages and in file
   comments.
5. Run `pnpm typecheck` (safe here, see `pnpm-workspace.yaml`) and load the extension in a new
   pi session to check the footer.

Alternative: re-root the fork on `fad85bd` and replay the six local commits on top
(`git rebase --onto`). That gives a shared ancestry and ordinary merges afterwards, at the cost
of rewriting every local commit hash. No remote holds the current hashes, so this stays a
one-time decision.
