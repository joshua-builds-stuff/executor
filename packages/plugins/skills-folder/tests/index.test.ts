import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

// oxlint-disable executor/no-try-catch-or-throw -- boundary: every filesystem fixture is cleaned up in finally even on test failure

import { skillsFolderSource } from "../src/index";

const digest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const decodeFixture = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      schema_version: Schema.String,
      skills: Schema.Array(
        Schema.Struct({
          category: Schema.String,
          name: Schema.String,
          files: Schema.Array(
            Schema.Struct({ path: Schema.String, size: Schema.Number, digest: Schema.String }),
          ),
        }),
      ),
    }),
  ),
);

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "executor-skills-folder-"));
  const path = join(root, "skills", "devops", "example");
  await mkdir(join(path, "references"), { recursive: true });
  const skill = Buffer.from(
    "---\nname: example\ndescription: Test a mounted skills folder.\n---\n\n# Example\n",
  );
  const unicode = Buffer.from("reference: ready\n");
  const binary = Buffer.from([0, 1, 2, 255]);
  await writeFile(join(path, "SKILL.md"), skill);
  await writeFile(join(path, "references", "路径 #1.md"), unicode);
  await writeFile(join(path, "image.png"), binary);
  await writeFile(join(path, "config.env"), "never serve unlisted files");
  const files = [
    { path: "SKILL.md", data: skill },
    { path: "references/路径 #1.md", data: unicode },
    { path: "image.png", data: binary },
  ];
  await writeFile(
    join(root, "catalog-manifest.json"),
    JSON.stringify({
      schema_version: "1.0.0",
      skills: [
        {
          category: "devops",
          name: "example",
          files: files.map((file) => ({
            path: file.path,
            size: file.data.length,
            digest: digest(file.data),
          })),
        },
      ],
    }),
  );
  return { root, path };
};

it("lists exact manifests and reads text, Unicode paths, and binary without serving unlisted files", async () => {
  const { root } = await fixture();
  try {
    const source = skillsFolderSource(root);
    const listed = await Effect.runPromise(source.list());
    expect(listed).toHaveLength(1);
    expect(listed[0]?.description).toBe("Test a mounted skills folder.");
    expect(listed[0]?.files).toHaveLength(3);
    const skill = await Effect.runPromise(source.get({ owner: "org", name: "example" }));
    expect(skill.files.find((file) => file.path === "references/路径 #1.md")?.content).toBe(
      "reference: ready\n",
    );
    expect(skill.files.find((file) => file.path === "image.png")).toMatchObject({
      encoding: "base64",
      content: Buffer.from([0, 1, 2, 255]).toString("base64"),
    });
    expect(skill.files.find((file) => file.path === "config.env")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses modified bytes even when the manifest still advertises the old digest", async () => {
  const { root, path } = await fixture();
  try {
    const source = skillsFolderSource(root);
    await writeFile(join(path, "image.png"), Buffer.from([0, 1, 2, 254]));
    await expect(Effect.runPromise(source.get({ owner: "org", name: "example" }))).rejects.toThrow(
      "snapshot changed without a new manifest",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses an unsafe manifest path before opening it", async () => {
  const { root } = await fixture();
  try {
    const manifestPath = join(root, "catalog-manifest.json");
    const raw = decodeFixture(await readFile(manifestPath, "utf8"));
    raw.skills[0].files[0].path = "../private.txt";
    await writeFile(manifestPath, JSON.stringify(raw));
    await expect(Effect.runPromise(skillsFolderSource(root).list())).rejects.toThrow(
      "unsafe file path",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reads updates in an existing session without replacing the source", async () => {
  const { root, path } = await fixture();
  try {
    const source = skillsFolderSource(root);
    expect((await Effect.runPromise(source.list()))[0]?.files[0]?.digest).toBe(
      digest(
        Buffer.from(
          "---\nname: example\ndescription: Test a mounted skills folder.\n---\n\n# Example\n",
        ),
      ),
    );
    const changed = Buffer.from(
      "---\nname: example\ndescription: Updated in place.\n---\n\n# Example\n",
    );
    await writeFile(join(path, "SKILL.md"), changed);
    const manifestPath = join(root, "catalog-manifest.json");
    const raw = decodeFixture(await readFile(manifestPath, "utf8"));
    raw.skills[0].files[0].size = changed.length;
    raw.skills[0].files[0].digest = digest(changed);
    await writeFile(manifestPath, JSON.stringify(raw));
    expect((await Effect.runPromise(source.list()))[0]?.description).toBe("Updated in place.");
    expect(
      (await Effect.runPromise(source.get({ owner: "org", name: "example" }))).files[0]?.content,
    ).toContain("Updated in place.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not follow a declared file outside its skill package", async () => {
  const { root, path } = await fixture();
  try {
    const manifestPath = join(root, "catalog-manifest.json");
    const raw = decodeFixture(await readFile(manifestPath, "utf8"));
    const outside = join(root, "other.txt");
    const secret = Buffer.from("not part of the skill");
    await writeFile(outside, secret);
    await symlink(outside, join(path, "references", "other.txt"));
    raw.skills[0].files.push({
      path: "references/other.txt",
      size: secret.length,
      digest: digest(secret),
    });
    await writeFile(manifestPath, JSON.stringify(raw));
    await expect(
      Effect.runPromise(skillsFolderSource(root).get({ owner: "org", name: "example" })),
    ).rejects.toThrow("file escapes configured folder");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
