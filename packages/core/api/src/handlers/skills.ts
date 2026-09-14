import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";
import type { Skill, SkillSummary } from "@executor-js/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { capture } from "@executor-js/api";

const summaryToResponse = (skill: SkillSummary) => ({
  owner: skill.owner,
  name: skill.name,
  description: skill.description,
  frontmatter: skill.frontmatter,
  files: skill.files,
  createdAt: skill.createdAt.getTime(),
  updatedAt: skill.updatedAt.getTime(),
});

const skillToResponse = (skill: Skill) => ({
  ...summaryToResponse(skill),
  files: skill.files,
});

export const SkillsHandlers = HttpApiBuilder.group(ExecutorApi, "skills", (handlers) =>
  handlers
    .handle("list", () =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const skills = yield* executor.skills.list();
          return skills.map(summaryToResponse);
        }),
      ),
    )
    .handle("get", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return skillToResponse(yield* executor.skills.get(params));
        }),
      ),
    )
    .handle("save", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return skillToResponse(yield* executor.skills.save(payload));
        }),
      ),
    )
    .handle("remove", ({ params }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          yield* executor.skills.remove(params);
          return { removed: true };
        }),
      ),
    ),
);
