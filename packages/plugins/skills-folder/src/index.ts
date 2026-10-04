import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";

import { Data, Effect, Predicate, Result, Schema } from "effect";
import {
  definePlugin,
  isValidSkillFilePath,
  isValidSkillName,
  parseSkillMarkdown,
  SkillName,
  SKILL_MAX_FILES,
  SKILL_MAX_TOTAL_BYTES,
  type McpSkillSource,
  type Skill,
  type SkillFile,
  type SkillFileEntry,
  type SkillSummary,
} from "@executor-js/sdk";

/** Read-only directory snapshot built from the catalog's Git-indexed files.
 * The container does not need Git or Python, and never walks arbitrary files. */
const MANIFEST = "catalog-manifest.json";
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const CATEGORY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".wasm",
  ".bin",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".sqlite",
  ".db",
  ".docx",
  ".pptx",
]);
const PRIVATE_DIRS = new Set([
  "__pycache__",
  "node_modules",
  ".venv",
  "venv",
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".fastembed_cache",
  ".cache",
  "cache",
  "caches",
  "downloads",
  "runtime",
  "runtime-state",
]);
const CAPTURE_DIRS = new Set(["snapshots", "captures", "thumbnails"]);
const CAPTURE_PREFIX = /^(snap_|snapshot_|capture_|thumb_|thumbnail_)/;

type FileRow = SkillFileEntry;
const CatalogManifest = Schema.fromJsonString(
  Schema.Struct({
    schema_version: Schema.Literal("1.0.0"),
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
);
type CatalogManifest = typeof CatalogManifest.Type;
type SkillRow = CatalogManifest["skills"][number];
const decodeManifest = Schema.decodeUnknownSync(CatalogManifest);

class SkillsFolderError extends Data.TaggedError("SkillsFolderError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const fail = (message: string): never => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: the filesystem loader is caught by Effect.tryPromise
  throw new SkillsFolderError({ message: `Skill folder: ${message}` });
};

const isSafeFile = (path: string): boolean => {
  if (!isValidSkillFilePath(path)) return false;
  const parts = path.toLowerCase().split("/");
  const name = parts[parts.length - 1] ?? "";
  return !(
    parts.some((part) => PRIVATE_DIRS.has(part)) ||
    CAPTURE_DIRS.has(parts[0] ?? "") ||
    name === "config.env" ||
    (CAPTURE_PREFIX.test(name) && /\.(?:jpe?g|png|webp|gif|bmp)$/.test(name))
  );
};

const parseManifest = (value: CatalogManifest): CatalogManifest => {
  if (value.skills.length > 10_000) return fail("manifest contains too many skills");
  const names = new Set<string>();
  for (const row of value.skills) {
    if (!CATEGORY.test(row.category) || !isValidSkillName(row.name)) {
      return fail("invalid category or skill name");
    }
    if (names.has(row.name)) return fail(`duplicate skill name ${row.name}`);
    names.add(row.name);
    if (row.files.length < 1 || row.files.length > SKILL_MAX_FILES) {
      return fail(`invalid file count for ${row.name}`);
    }
    const paths = new Set<string>();
    let total = 0;
    for (const file of row.files) {
      if (!isSafeFile(file.path)) {
        return fail(`unsafe file path in ${row.name}`);
      }
      if (paths.has(file.path)) return fail(`duplicate file in ${row.name}`);
      paths.add(file.path);
      if (!Number.isSafeInteger(file.size) || file.size < 0 || !DIGEST.test(file.digest)) {
        return fail(`invalid file manifest in ${row.name}`);
      }
      total += file.size;
    }
    if (!paths.has("SKILL.md") || total > SKILL_MAX_TOTAL_BYTES) {
      return fail(`invalid package size or missing SKILL.md in ${row.name}`);
    }
  }
  return value;
};

const bytesFor = async (root: string, row: SkillRow, file: FileRow): Promise<Buffer> => {
  const path = join(root, "skills", row.category, row.name, file.path);
  const resolved = await realpath(path);
  const packageRoot = join(root, "skills", row.category, row.name);
  if (!resolved.startsWith(packageRoot + sep)) {
    return fail(`file escapes configured folder: ${row.name}/${file.path}`);
  }
  if ((await stat(resolved)).size !== file.size) {
    return fail(`snapshot changed without a new manifest: ${row.name}/${file.path}`);
  }
  const bytes = await readFile(resolved);
  if (
    bytes.length !== file.size ||
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== file.digest
  ) {
    return fail(`snapshot changed without a new manifest: ${row.name}/${file.path}`);
  }
  return bytes;
};

const catalog = async (configuredRoot: string, name?: string) => {
  const root = await realpath(configuredRoot);
  const manifestPath = join(root, MANIFEST);
  if ((await realpath(manifestPath)) !== manifestPath)
    return fail("manifest escapes configured folder");
  if ((await stat(manifestPath)).size > MAX_MANIFEST_BYTES) return fail("manifest is too large");
  const raw = await readFile(manifestPath);
  if (raw.length > MAX_MANIFEST_BYTES) return fail("manifest is too large");
  const rows = parseManifest(decodeManifest(raw.toString("utf8"))).skills;
  const summaries: SkillSummary[] = [];
  for (const row of rows) {
    if (name && row.name !== name) continue;
    const file = row.files.find((entry) => entry.path === "SKILL.md")!;
    const bytes = await bytesFor(root, row, file);
    const markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (markdown.includes("\0")) return fail(`invalid SKILL.md in ${row.name}`);
    const parsed = parseSkillMarkdown(markdown);
    if (Result.isFailure(parsed) || parsed.success.name !== row.name) {
      return fail(`invalid SKILL.md frontmatter in ${row.name}`);
    }
    summaries.push({
      owner: "org",
      name: SkillName.make(row.name),
      description: parsed.success.description,
      frontmatter: parsed.success.frontmatter,
      files: row.files,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
  }
  return { root, rows, summaries };
};

export const skillsFolderSource = (root: string): McpSkillSource => {
  if (!isAbsolute(root)) fail("configure an absolute skills folder path");
  const read = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: (cause) =>
        Predicate.isTagged(cause, "SkillsFolderError")
          ? cause
          : new SkillsFolderError({ message: "Skill folder: failed to read catalog", cause }),
    });
  return {
    replacesSavedOwners: ["org"],
    list: () => read(() => catalog(root).then((result) => result.summaries)),
    get: (ref) =>
      read(async () => {
        if (ref.owner !== "org") return fail(`unknown skill: ${ref.owner}/${ref.name}`);
        const snapshot = await catalog(root, ref.name);
        const row = snapshot.rows.find((item) => item.name === ref.name);
        const summary = snapshot.summaries.find((item) => item.name === ref.name);
        if (!row || !summary) return fail(`unknown skill: ${ref.owner}/${ref.name}`);
        const files: SkillFile[] = [];
        for (const file of row.files) {
          const bytes = await bytesFor(snapshot.root, row, file);
          const text = Result.try(() =>
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
          );
          const encoded =
            BINARY_EXTENSIONS.has(`.${file.path.split(".").pop()?.toLowerCase()}`) ||
            Result.isFailure(text) ||
            text.success.includes("\0") ||
            Buffer.byteLength(text.success) !== bytes.length;
          files.push({
            ...file,
            content: encoded ? bytes.toString("base64") : text.success,
            ...(encoded ? { encoding: "base64" as const } : {}),
          });
        }
        return { ...summary, files } satisfies Skill;
      }),
  };
};

export const skillsFolderPlugin = (root: string) =>
  definePlugin(() => ({
    id: "skills-folder" as const,
    storage: () => ({}),
    mcpSkills: () => skillsFolderSource(root),
  }))();
