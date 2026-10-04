#!/usr/bin/env python3
"""Build a read-only Executor skills-folder snapshot from the catalog Git index.

Only Git-indexed package files (and explicit package-files.json additions) are
admitted. The result is self-contained: no Git binary or symlinks are needed in
the Executor container. The destination must not already exist.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path, PurePosixPath
from typing import Mapping

_NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
_GENERATED = frozenset({
    "__pycache__", "node_modules", ".venv", "venv", ".git", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".fastembed_cache", ".cache", "cache",
    "caches", "downloads", "runtime", "runtime-state",
})
_CAPTURE_DIRS = frozenset({"snapshots", "captures", "thumbnails"})
_CAPTURE_PREFIX = ("snap_", "snapshot_", "capture_", "thumb_", "thumbnail_")
_CAPTURE_EXT = frozenset({".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"})
def admitted(path: str) -> bool:
    if (len(path) > 512 or "\\" in path or any(ord(char) < 32 or ord(char) == 127 for char in path)
            or any(part in {"", ".", ".."} for part in path.split("/"))):
        return False
    parts = tuple(part.casefold() for part in PurePosixPath(path).parts)
    name = parts[-1] if parts else ""
    return bool(parts) and not (
        any(part in _GENERATED for part in parts)
        or parts[0] in _CAPTURE_DIRS
        or name == "config.env"
        or (name.startswith(_CAPTURE_PREFIX) and PurePosixPath(name).suffix in _CAPTURE_EXT)
    )


def git(root: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(root), *args])


def declared_files(root: Path, package: str, tracked: set[str]) -> set[str]:
    declaration = f"{package}/package-files.json"
    if declaration not in tracked:
        if (root / declaration).exists():
            raise ValueError(f"untracked declaration: {declaration}")
        return set()
    raw = json.loads(git(root, "show", f":{declaration}"))
    if (set(raw) != {"schema_version", "include"} or raw["schema_version"] != "1.0.0"
            or not isinstance(raw["include"], list)):
        raise ValueError(f"malformed declaration: {declaration}")
    found = set()
    for path in raw["include"]:
        if not isinstance(path, str) or not path or "\\" in path or any(c in path for c in "*?[]"):
            raise ValueError(f"invalid include in {declaration}")
        posix = PurePosixPath(path)
        if (posix.is_absolute() or path != posix.as_posix()
                or any(part in {".", ".."} for part in path.split("/")) or not admitted(path)):
            raise ValueError(f"unsafe include in {declaration}")
        candidate = root / package / path
        if (candidate.is_symlink() or not candidate.is_file()
                or not candidate.resolve().is_relative_to((root / package).resolve())):
            raise ValueError(f"invalid include target in {declaration}")
        found.add(path)
    return found


def frontmatter_name(content: bytes) -> str:
    text = content.decode("utf-8-sig")
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError("missing frontmatter")
    name = None
    for line in lines[1:]:
        if line.strip() == "---":
            if name is None:
                raise ValueError("missing frontmatter name")
            return name
        if line.startswith("name:"):
            name = line.partition(":")[2].strip().strip('"\'')
    raise ValueError("unclosed frontmatter")


def build(root: Path, output: Path, allow_symlinks: Mapping[str, Path] | None = None) -> tuple[int, int]:
    root = root.resolve(strict=True)
    allow_symlinks = allow_symlinks or {}
    if os.path.lexists(output):
        raise ValueError(f"output already exists: {output}")
    if output.resolve().is_relative_to(root):
        raise ValueError("output must be outside the catalog checkout")
    if Path(git(root, "rev-parse", "--show-toplevel").decode().strip()).resolve() != root:
        raise ValueError("catalog root must be the Git repository root")
    tracked = {
        entry for entry in git(root, "ls-files", "--cached", "-z", "--", "skills/")
        .decode("utf-8", errors="surrogateescape").split("\0") if entry
    }
    packages: dict[str, set[str]] = {}
    for path in tracked:
        parts = PurePosixPath(path).parts
        if len(parts) < 4 or not _NAME.fullmatch(parts[1]) or not _NAME.fullmatch(parts[2]):
            continue
        packages.setdefault("/".join(parts[:3]), set()).add("/".join(parts[3:]))

    rows = []
    staged: list[tuple[str, bytes]] = []
    names = set()
    for package, indexed in sorted(packages.items()):
        category, name = package.split("/")[1:]
        if "SKILL.md" not in indexed:
            continue  # physical but unindexed skill directories are private
        if not (root / package).is_dir():
            continue  # indexed but deleted in this worktree
        if not (root / package).resolve(strict=True).is_relative_to(root):
            raise ValueError(f"package directory escapes catalog: {package}")
        selected = {
            path for path in indexed
            if admitted(path) and (root / package / path).is_file()
        } | declared_files(root, package, tracked)
        if "SKILL.md" not in selected:
            continue  # tracked but deleted locally; same fail-closed skip as the publisher
        if name in names:
            raise ValueError(f"ambiguous skill name: {name}")
        names.add(name)
        paths = sorted(selected, key=lambda path: (path != "SKILL.md", path))
        if len(paths) > 2048:
            raise ValueError(f"too many files in {package}")
        files = []
        total = 0
        for path in paths:
            source = root / package / path
            resolved = source.resolve(strict=True)
            if resolved != source:
                approved = allow_symlinks.get(f"{package}/{path}")
                if approved is None or resolved != approved.resolve(strict=True):
                    raise ValueError(f"unapproved symlink: {package}/{path}")
            elif not resolved.is_relative_to((root / package).resolve(strict=True)):
                raise ValueError(f"path escapes package: {package}/{path}")
            content = source.read_bytes()
            total += len(content)
            if total > 64 * 1024 * 1024:
                raise ValueError(f"package exceeds 64 MiB: {package}")
            if path == "SKILL.md" and frontmatter_name(content) != name:
                raise ValueError(f"frontmatter name mismatch: {package}")
            if path == "SKILL.md" and "\0" in content.decode("utf-8"):
                raise ValueError(f"invalid SKILL.md: {package}")
            files.append({
                "path": path, "size": len(content),
                "digest": "sha256:" + hashlib.sha256(content).hexdigest(),
            })
            staged.append((f"{package}/{path}", content))
        rows.append({"category": category, "name": name, "files": files})

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".executor-skills-", dir=output.parent) as temporary:
        stage = Path(temporary)
        stage.chmod(0o755)
        for path, content in staged:
            target = stage / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        (stage / "catalog-manifest.json").write_text(
            json.dumps({"schema_version": "1.0.0", "skills": rows}, ensure_ascii=False),
            encoding="utf-8",
        )
        for entry in stage.rglob("*"):
            entry.chmod(0o755 if entry.is_dir() else 0o644)
        stage.rename(output)
    return len(rows), len(staged)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog-root", type=Path, required=True, help="Git-indexed shuvbot-skills checkout")
    parser.add_argument("--output", type=Path, required=True, help="new snapshot directory; must not exist")
    parser.add_argument(
        "--allow-symlink", action="append", default=[], metavar="INDEXED_PATH=ABSOLUTE_TARGET",
        help="explicitly trust one indexed symlink and its exact resolved target (repeatable)",
    )
    args = parser.parse_args()
    approved = {}
    for rule in args.allow_symlink:
        path, separator, target = rule.partition("=")
        if not separator or not path.startswith("skills/") or not admitted(path) or not Path(target).is_absolute():
            parser.error(f"invalid --allow-symlink: {rule}")
        if path in approved:
            parser.error(f"duplicate --allow-symlink: {path}")
        approved[path] = Path(target)
    count, files = build(args.catalog_root, args.output, approved)
    print(f"Snapshot ready: {count} skills / {files} files at {args.output}")


if __name__ == "__main__":
    main()
