#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { releaseTagIntegrityFailures } from "./lib/release-tag-integrity.mjs";

function value(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const version = (value("version") ?? "").replace(/^v/, "");
const releaseCommit = value("release-commit") ?? "";
const mainRef = value("main-ref") ?? "refs/remotes/origin/main";

if (!version || !releaseCommit) {
  console.error("Usage: node scripts/release-tag-integrity.mjs --version VERSION --release-commit SHA [--main-ref REF]");
  process.exit(2);
}

const mainCommit = git(["rev-parse", "--verify", `${mainRef}^{commit}`]);
const tag = `v${version}`;
let tagCommit = null;
let tagIsAncestor = null;
try {
  tagCommit = git(["rev-parse", "--verify", `${tag}^{commit}`]);
  tagIsAncestor = spawnSync("git", ["merge-base", "--is-ancestor", tagCommit, mainCommit]).status === 0;
} catch {
  tagCommit = null;
}

const failures = releaseTagIntegrityFailures({
  version,
  releaseCommit,
  mainCommit,
  tagCommit,
  tagIsAncestor,
});

if (failures.length > 0) {
  for (const failure of failures) console.error(`Release integrity failure: ${failure}`);
  process.exit(1);
}

console.log(
  tagCommit
    ? `Release integrity passed: ${tag} and main both resolve to ${releaseCommit}.`
    : `Release integrity passed: main resolves to ${releaseCommit}; ${tag} will be created after validation.`,
);
