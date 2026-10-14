import assert from "node:assert/strict";
import test from "node:test";

import { canonicalArmSpec, toolBudgetIdentity } from "./experiment-identity.js";

test("canonicalArmSpec renames only the legacy web branch", () => {
  assert.deepEqual(canonicalArmSpec("web"), {
    canonical: "web-filter",
    usedLegacyWebAlias: true,
  });
  assert.equal(canonicalArmSpec("web+expand").canonical, "web-filter+expand");
  for (const arm of ["frozen+web", "web-filter+frozen", "frozen+web-filter+expand", "both+expand", "mixed+backsearch"])
    assert.throws(() => canonicalArmSpec(arm), /removed|cannot be combined/);
  assert.equal(canonicalArmSpec("both").canonical, "both");
  assert.equal(canonicalArmSpec("mixed").canonical, "both");
  assert.equal(canonicalArmSpec("backsearch").canonical, "backsearch");
});

test("toolBudgetIdentity makes the shared search/fetch cap explicit", () => {
  assert.deepEqual(toolBudgetIdentity(true, 100, 20), {
    max_tool_calls: 100,
    max_search_calls: 100,
    max_fetch_calls: 100,
    max_results_per_search: 20,
    budget_scope: "shared-across-search-and-fetch",
  });
  assert.deepEqual(toolBudgetIdentity(false, 100, 20), {
    max_tool_calls: 0,
    max_search_calls: 0,
    max_fetch_calls: 0,
    max_results_per_search: null,
    budget_scope: "no-tools",
  });
});

test('mixed admission includes both frozen and web resources',async()=>{
  const {armUsesFrozen,armUsesWebFilter}=await import('./experiment-identity.js');
  assert.equal(armUsesFrozen('mixed'),true);assert.equal(armUsesWebFilter('mixed'),true);
  assert.equal(armUsesFrozen('none,web-filter'),false);assert.equal(armUsesWebFilter('none,frozen'),false);
});
