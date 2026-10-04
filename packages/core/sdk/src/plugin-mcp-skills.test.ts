import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { definePlugin } from "./plugin";
import { SkillName } from "./ids";
import type { SkillSummary } from "./skill";
import { makeTestExecutor } from "./test-config";

it.effect("exposes a plugin's live, read-only MCP skill source without saving a skill", () =>
  Effect.gen(function* () {
    const description = { current: "From a configured folder" };
    const summary = (): SkillSummary => ({
      owner: "org",
      name: SkillName.make("folder-example"),
      description: description.current,
      frontmatter: { name: "folder-example", description: description.current },
      files: [{ path: "SKILL.md", size: 6, digest: `sha256:${"a".repeat(64)}` }],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const plugin = definePlugin(() => ({
      id: "folder-example" as const,
      storage: () => ({}),
      mcpSkills: () => ({
        list: () => Effect.succeed([summary()]),
        get: () =>
          Effect.succeed({
            ...summary(),
            files: [{ ...summary().files[0]!, content: "# Hello" }],
          }),
      }),
    }))();
    const executor = yield* makeTestExecutor({ plugins: [plugin] as const });
    expect(yield* executor.skills.list()).toEqual([]);
    expect(executor.mcpSkillSources).toHaveLength(1);
    expect((yield* executor.mcpSkillSources[0]!.list())[0]?.description).toBe(
      "From a configured folder",
    );
    description.current = "Updated without saving to Executor";
    expect(
      (yield* executor.mcpSkillSources[0]!.get({ owner: "org", name: "folder-example" }))
        .description,
    ).toBe("Updated without saving to Executor");
  }),
);
