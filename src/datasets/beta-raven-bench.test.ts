import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PKG_ROOT } from "../paths.js";
import { betaRavenQuestionSetIdentity } from "./beta-raven-bench.js";

// The legacy question set is not part of the public source tree.
const present = existsSync(join(PKG_ROOT, "vendor/beta-raven-bench/data/polymarket-march-2026/manifest.json"));

test("question-set identity includes the upstream selector version", { skip: !present && "legacy question set absent" }, () => {
  const identity = betaRavenQuestionSetIdentity("selected_300");
  assert.match(
    identity.question_set_id,
    /^beta-raven-pm-202603-selected300@\d{4}-\d{2}-\d{2}\.\d+$/,
  );
  assert.equal(identity.split, "selected_300");
  assert.match(identity.manifest_sha256, /^[a-f0-9]{64}$/);
});
