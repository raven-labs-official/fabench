import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codeCommit, executionSourceFiles, releaseCommit, releaseTrackedFiles } from "../code-version.js";
import { experimentCodeIdentity } from "./registry.js";

test("release metadata supplies commit and tracked files without a trusted Git checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "fabench-release-metadata-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "tools"));
  const commit = "a".repeat(40);
  writeFileSync(join(root, ".git", "raven-release-commit"), `${commit}\n`);
  writeFileSync(
    join(root, ".git", "raven-release-files"),
    "src/example.ts\ntools/helper.py\npackage.json\n",
  );
  writeFileSync(join(root, "src", "example.ts"), "export const answer = 42;\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "tools", "helper.py"), "print('v1')\n");

  assert.equal(releaseCommit(root), commit);
  assert.equal(codeCommit(root), commit);
  assert.deepEqual(releaseTrackedFiles(root), ["src/example.ts", "tools/helper.py", "package.json"]);

  const identity = experimentCodeIdentity(root);
  assert.equal(identity.git_commit, commit);
  assert.notEqual(identity.source_fingerprint_sha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  writeFileSync(join(root, "tools", "helper.py"), "print('v2')\n");
  assert.notEqual(
    experimentCodeIdentity(root).source_fingerprint_sha256,
    identity.source_fingerprint_sha256,
  );
});

test("invalid release commit metadata is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "fabench-release-metadata-"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "raven-release-commit"), "not-a-commit\n");
  assert.equal(releaseCommit(root), null);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "protocol.file.allow=always", "-c", "user.name=FABench Test", "-c", "user.email=test@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRepository(root: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  git(root, "init", "-q");
  writeFileSync(join(root, "src", "example.ts"), "export const value = 1;\n");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Initial source");
}

test("run identity expands submodule source, including nested and untracked files", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "fabench-submodule-identity-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const leaf = join(workspace, "leaf");
  const infra = join(workspace, "infra");
  const root = join(workspace, "bench");
  for (const repo of [leaf, infra, root]) createRepository(repo);
  git(infra, "submodule", "add", "-q", leaf, "vendor/leaf");
  git(infra, "commit", "-qam", "Add nested dependency");
  git(root, "submodule", "add", "-q", infra, "vendor/retrieval-infra");
  git(root, "commit", "-qam", "Pin retrieval dependency");
  git(root, "submodule", "update", "--init", "--recursive");

  const child = join(root, "vendor", "retrieval-infra");
  const files = executionSourceFiles(root);
  assert.ok(files.includes("vendor/retrieval-infra/src/example.ts"));
  assert.ok(files.includes("vendor/retrieval-infra/vendor/leaf/src/example.ts"));
  assert.ok(!files.includes("vendor/retrieval-infra"));
  const original = experimentCodeIdentity(root).source_fingerprint_sha256;
  writeFileSync(join(child, "src", "example.ts"), "export const value = 2;\n");
  const changed = experimentCodeIdentity(root).source_fingerprint_sha256;
  assert.notEqual(changed, original);
  writeFileSync(join(child, "src", "new.ts"), "export const extra = true;\n");
  const untracked = experimentCodeIdentity(root).source_fingerprint_sha256;
  assert.notEqual(untracked, changed);
  mkdirSync(join(child, "node_modules"));
  writeFileSync(join(child, "node_modules", "ignored.js"), "irrelevant dependency install output\n");
  assert.equal(experimentCodeIdentity(root).source_fingerprint_sha256, untracked);
  writeFileSync(join(child, "vendor", "leaf", "src", "example.ts"), "export const value = 3;\n");
  assert.notEqual(experimentCodeIdentity(root).source_fingerprint_sha256, untracked);
});

test("relocated submodule release keeps its fingerprint, also when Git is unavailable", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "fabench-submodule-release-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const infra = join(workspace, "infra");
  let root = join(workspace, "bench");
  for (const repo of [infra, root]) createRepository(repo);
  git(root, "submodule", "add", "-q", infra, "vendor/retrieval-infra");
  git(root, "commit", "-qam", "Pin retrieval dependency");
  const original = experimentCodeIdentity(root);
  const files = git(root, "ls-files", "--recurse-submodules");

  const published = join(workspace, "published");
  renameSync(root, published);
  root = published;
  assert.deepEqual(experimentCodeIdentity(root), original);
  assert.equal(git(root, "status", "--porcelain"), "");

  // Preserve the bytes and release metadata while making Git unable to open the repo.
  renameSync(join(root, ".git"), join(workspace, "saved-git-metadata"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "raven-release-commit"), `${original.git_commit}\n`);
  writeFileSync(join(root, ".git", "raven-release-files"), `${files}\n`);
  assert.deepEqual(experimentCodeIdentity(root), original);
  writeFileSync(join(root, "vendor", "retrieval-infra", "src", "example.ts"), "export const value = 9;\n");
  assert.notEqual(experimentCodeIdentity(root).source_fingerprint_sha256, original.source_fingerprint_sha256);
});
