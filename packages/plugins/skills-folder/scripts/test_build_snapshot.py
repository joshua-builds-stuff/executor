"""The snapshot contains only Git-indexed, admitted package files."""

import importlib.util
import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location("snapshot", Path(__file__).with_name("build-snapshot.py"))
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="executor-snapshot-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "catalog"
        self.root.mkdir()
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)

    def add(self, path, content, *, indexed=True):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        if indexed:
            subprocess.run(["git", "add", "--", path], cwd=self.root, check=True)
        return target

    def test_indexed_files_binary_unicode_and_private_exclusions(self):
        self.add("skills/devops/example/SKILL.md", b"---\nname: example\ndescription: test\n---\nHi\n")
        self.add("skills/devops/example/references/路径 #1.md", "café\n".encode())
        self.add("skills/devops/example/assets/logo.png", bytes([0, 1, 255]))
        self.add("skills/devops/example/config.env", b"PRIVATE")
        self.add("skills/devops/example/snapshots/snap_1.png", b"PRIVATE")
        self.add("skills/devops/example/untracked.txt", b"PRIVATE", indexed=False)
        out = self.base / "snapshot"
        self.assertEqual(snapshot.build(self.root, out), (1, 3))
        rows = json.loads((out / "catalog-manifest.json").read_text())["skills"]
        self.assertEqual({item["path"] for item in rows[0]["files"]}, {
            "SKILL.md", "references/路径 #1.md", "assets/logo.png",
        })
        self.assertEqual((out / "skills/devops/example/assets/logo.png").read_bytes(), bytes([0, 1, 255]))
        self.assertFalse((out / "skills/devops/example/untracked.txt").exists())
        self.assertEqual(stat.S_IMODE(out.stat().st_mode), 0o755, "container users must traverse the snapshot")

    def test_skips_an_unindexed_or_deleted_skill(self):
        self.add("skills/devops/private/SKILL.md", b"---\nname: private\n---\n", indexed=False)
        self.add("skills/devops/deleted/SKILL.md", b"---\nname: deleted\n---\n").unlink()
        self.assertEqual(snapshot.build(self.root, self.base / "snapshot"), (0, 0))

    def test_nested_files_are_readable_with_restrictive_umask(self):
        self.add("skills/devops/example/SKILL.md", b"---\nname: example\n---\n")
        previous = os.umask(0o077)
        try:
            out = self.base / "snapshot"
            snapshot.build(self.root, out)
        finally:
            os.umask(previous)
        self.assertEqual(stat.S_IMODE((out / "skills/devops/example").stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((out / "skills/devops/example/SKILL.md").stat().st_mode), 0o644)

    def test_rejects_symlink_outside_package_without_publishing_partial_output(self):
        self.add("skills/devops/example/SKILL.md", b"---\nname: example\n---\n")
        outside = self.add("private.txt", b"SECRET", indexed=False)
        symlink = self.root / "skills/devops/example/references/leak.txt"
        symlink.parent.mkdir()
        symlink.symlink_to(outside)
        subprocess.run(["git", "add", "--", "skills/devops/example/references/leak.txt"], cwd=self.root, check=True)
        out = self.base / "snapshot"
        with self.assertRaisesRegex(ValueError, "unapproved symlink"):
            snapshot.build(self.root, out)
        self.assertFalse(out.exists())

    def test_allows_only_a_named_symlink_to_its_exact_explicit_target(self):
        canonical = self.base / "canonical" / "SKILL.md"
        canonical.parent.mkdir()
        canonical.write_bytes(b"---\nname: example\ndescription: canonical\n---\n")
        linked = self.root / "skills/devops/example/SKILL.md"
        linked.parent.mkdir(parents=True)
        linked.symlink_to(canonical)
        subprocess.run(["git", "add", "--", "skills/devops/example/SKILL.md"], cwd=self.root, check=True)
        with self.assertRaisesRegex(ValueError, "unapproved symlink"):
            snapshot.build(self.root, self.base / "rejected")
        wrong_target = self.base / "wrong-target"
        wrong_target.write_bytes(b"not the canonical skill")
        with self.assertRaisesRegex(ValueError, "unapproved symlink"):
            snapshot.build(self.root, self.base / "wrong", {
                "skills/devops/example/SKILL.md": wrong_target,
            })
        out = self.base / "approved"
        self.assertEqual(snapshot.build(self.root, out, {
            "skills/devops/example/SKILL.md": canonical,
        }), (1, 1))
        copied = out / "skills/devops/example/SKILL.md"
        self.assertFalse(copied.is_symlink())
        self.assertEqual(copied.read_bytes(), canonical.read_bytes())

    def test_refuses_existing_output_and_untracked_declaration(self):
        self.add("skills/devops/example/SKILL.md", b"---\nname: example\n---\n")
        self.add("skills/devops/example/package-files.json", b'{"schema_version":"1.0.0","include":[]}', indexed=False)
        with self.assertRaisesRegex(ValueError, "untracked declaration"):
            snapshot.build(self.root, self.base / "snapshot")
        (self.root / "skills/devops/example/package-files.json").unlink()
        out = self.base / "snapshot"
        out.mkdir()
        with self.assertRaisesRegex(ValueError, "already exists"):
            snapshot.build(self.root, out)


if __name__ == "__main__":
    unittest.main()
