# Skills folder plugin (self-host)

Serve a canonical `skills/<category>/<name>/SKILL.md` catalog on Executor's **existing `/mcp` endpoint**. Set `EXECUTOR_SKILLS_FOLDER` to an absolute, read-only directory **inside the container**. No additional MCP server, API key, or per-skill upload is needed. The plugin reads files and returns them through `skills/list`, `skills/get`, `resources/read`, and Executor's `skills` tool; it never executes scripts.

## Prepare the folder

A snapshot uses a Git-index-derived `catalog-manifest.json` at its root and the matching `skills/` tree. Build it outside a local catalog Git checkout:

```sh
python3 packages/plugins/skills-folder/scripts/build-snapshot.py \
  --catalog-root /path/to/catalog-repo \
  --output /path/to/new-catalog-snapshot
```

The output path must be new. Only Git-indexed files and explicitly declared `package-files.json` additions are included; runtime files, secret/config files, captured images, and unindexed skill directories stay out. The builder copies original bytes, verifies the frontmatter name, and writes SHA-256 digests. A skill with a tracked but deleted `SKILL.md` is skipped, not restored from Git. Symlinks are refused by default; for a deliberately linked canonical file, pass `--allow-symlink skills/<category>/<name>/SKILL.md=/absolute/path/to/canonical/SKILL.md`. The builder verifies the exact resolved target and copies bytes, not the symlink. Review the printed skill/file counts before mounting.

Mount the resulting folder read-only and set the container path, e.g. in a Compose override:

```yaml
services:
  executor:
    environment:
      EXECUTOR_SKILLS_FOLDER: /catalog
    volumes:
      - /absolute/path/to/new-catalog-snapshot:/catalog:ro
```

Leave `EXECUTOR_SKILLS_FOLDER` unset to disable the plugin; Executor's saved skills still work. The host must be able to traverse the snapshot directory. A missing, corrupt, oversized, or escaping manifest fails the folder read rather than serving unlisted or modified bytes. If a single file changes without its digest manifest, the affected read fails; write a new snapshot and switch the mount or update files with the manifest **last**. Existing MCP sessions read the current snapshot at the next list/get/resource call; a remount to a different host directory requires a container restart.

## Precedence and rollback

The explicitly configured folder replaces **all saved org skills on `/mcp`** while enabled, including any that are absent from the folder. This prevents deletions from resurrecting an old published copy. Saved personal skills remain available; a personal skill still wins a bare-name lookup in the `skills` tool. Two plugins claiming the same identity fail as ambiguous. **This plugin never modifies the database.** Previously published org skills remain visible through the console and `/api/skills`, and unsetting the env var restores them on `/mcp`. Before activation, review any org skills that should remain available but are not in the folder. Stop the old catalog publisher after switching to the plugin; it is not part of ongoing delivery.

The folder is trusted configuration. Do not mount an arbitrary/unreviewed checkout or a writable directory shared with untrusted users. The plugin validates both the manifest and the bytes served, keeps files within their declared package, and treats binaries as MCP blobs.
