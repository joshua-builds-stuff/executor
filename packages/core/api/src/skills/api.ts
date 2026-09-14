// ---------------------------------------------------------------------------
// Skills HTTP API — Agent Skills (SKILL.md directories) saved to the workspace.
//
// A skill is identified by `(owner, name)`: `org` skills are shared with the
// whole workspace, `user` skills are personal. The name comes from the SKILL.md
// frontmatter, so `save` takes only the owner and the files. Reads return what
// the bound owner scope may see, exactly like connections.
// ---------------------------------------------------------------------------

import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import {
  InternalError,
  InvalidSkillError,
  OrgWriteDeniedError,
  Owner,
  SkillName,
  SkillNotFoundError,
} from "@executor-js/sdk/shared";

const SkillParams = { owner: Owner, name: SkillName };

const SkillFileEntryResponse = Schema.Struct({
  path: Schema.String,
  size: Schema.Number,
  digest: Schema.String,
});

const SkillFileResponse = Schema.Struct({
  ...SkillFileEntryResponse.fields,
  content: Schema.String,
});

/** What a list returns: the manifest without file contents. */
export const SkillSummaryResponse = Schema.Struct({
  owner: Owner,
  name: SkillName,
  description: Schema.String,
  frontmatter: Schema.Record(Schema.String, Schema.Unknown),
  files: Schema.Array(SkillFileEntryResponse),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const SkillResponse = Schema.Struct({
  ...SkillSummaryResponse.fields,
  files: Schema.Array(SkillFileResponse),
});

const SkillFileInputSchema = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
});

/** Create or replace: the skill's name is read from `SKILL.md`. */
const SaveSkillPayload = Schema.Struct({
  owner: Owner,
  files: Schema.Array(SkillFileInputSchema),
});

export const SkillsApi = HttpApiGroup.make("skills")
  .add(
    HttpApiEndpoint.get("list", "/skills", {
      success: Schema.Array(SkillSummaryResponse),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/skills/:owner/:name", {
      params: SkillParams,
      success: SkillResponse,
      error: [InternalError, SkillNotFoundError],
    }),
  )
  .add(
    HttpApiEndpoint.put("save", "/skills", {
      payload: SaveSkillPayload,
      success: SkillResponse,
      error: [InternalError, InvalidSkillError, OrgWriteDeniedError],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/skills/:owner/:name", {
      params: SkillParams,
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: [InternalError, OrgWriteDeniedError],
    }),
  );
