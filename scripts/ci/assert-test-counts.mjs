#!/usr/bin/env node
// Arbiter for the CI test run. Parses `cargo test` output and decides pass or
// fail INSTEAD of cargo's exit code, because this repo has already produced
// five distinct shapes of "green while proving nothing" (see the workflow
// header). Every rule below exists to kill one of them:
//
//  1. EVERY test binary must run. The expected set is discovered from
//     programs/burner/tests/*.rs at run time (plus the lib unit tests), so a
//     binary that silently stops being compiled or executed -- the
//     `#[ignore]`-when-artifact-missing failure mode -- is a hard failure,
//     and a newly added test file is required automatically, with no baseline
//     file to forget to update.
//  2. `ignored` must be 0 everywhere. The suite is run with
//     `--include-ignored`; if anyone "tidies" that flag away, dozens of
//     artifact tests report as ignored and this script goes red. The flag is
//     therefore self-enforcing.
//  3. Every non-quarantined binary must report >= 1 passed and 0 failed.
//  4. The total passed count must not drop below MIN_EXECUTED_TESTS (set in
//     the workflow). This catches a binary shrinking (22 -> 2) that rule 3
//     alone would miss. Raise the floor when tests are added; lowering it
//     requires a written reason in the commit that lowers it.
//  5. QUARANTINE (expected-fail) is loud, asserted, and self-expiring: a
//     quarantined binary must still RUN and must still FAIL. If it starts
//     passing, this script fails the job until it is removed from the list --
//     so a fix cannot coexist with a stale quarantine entry. Quarantined
//     tests never count toward the floor.
//
// Usage: node scripts/ci/assert-test-counts.mjs <cargo-test-log>
// Env:   MIN_EXECUTED_TESTS  (required) total-passed floor over
//                            non-quarantined binaries
//        GITHUB_STEP_SUMMARY (optional) markdown summary sink

import { readFileSync, readdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Quarantine list: binaries known-red against the only buildable artifact,
// kept running and asserted STILL-failing until the owner decides their fate.
// An entry here is a debt with a name on it, printed on every run.
// ---------------------------------------------------------------------------
const QUARANTINE = {
  // Empty, and that is the point: an entry here is a debt with a name on it.
  //
  // directcurve_artifact was quarantined here on 2026-08-26 and is now REMOVED
  // because it was fixed, not because the entry was inconvenient. It has been
  // re-pointed at the merged keyless build and passes 11/11. Note the
  // quarantine comment predicted "no buildable artifact can satisfy this
  // suite" and "owner decision needed: retire or re-point" -- the re-point
  // won, and retiring would have silently dropped its privilege-escalation
  // and buy-encoder coverage, which nothing else provides.
  //
  // This rule did its job: the arbiter failed the build the moment the suite
  // started passing, refusing to let a stale expected-fail entry coexist with
  // a real fix. Keep it that way.
};

const logPath = process.argv[2];
if (!logPath) {
  console.error("usage: assert-test-counts.mjs <cargo-test-log>");
  process.exit(2);
}
const minTotal = Number(process.env.MIN_EXECUTED_TESTS);
if (!Number.isFinite(minTotal) || minTotal <= 0) {
  console.error("error: MIN_EXECUTED_TESTS must be set to a positive integer");
  process.exit(2);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const testsDir = join(repoRoot, "programs", "burner", "tests");
const expected = readdirSync(testsDir)
  .filter((f) => f.endsWith(".rs"))
  .map((f) => f.replace(/\.rs$/, ""));
expected.push("lib");

const log = readFileSync(logPath, "utf8").split("\n");

// Pair each "Running ..." / "Doc-tests ..." header with the next
// "test result:" line. Format observed from libtest:
//   Running unittests src/lib.rs (...)            -> lib
//   Running tests/keyless_fuzz.rs (...)           -> keyless_fuzz
//   Doc-tests pinocchio_parity                    -> doc
//   test result: ok. 22 passed; 0 failed; 0 ignored; 0 measured; ...
const results = new Map();
let current = null;
const headerLib = /^\s+Running unittests src\/lib\.rs \(/;
const headerTest = /^\s+Running tests\/([A-Za-z0-9_]+)\.rs \(/;
const headerDoc = /^\s+Doc-tests /;
const resultLine =
  /^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out/;

for (const line of log) {
  let m;
  if (headerLib.test(line)) current = "lib";
  else if ((m = line.match(headerTest))) current = m[1];
  else if (headerDoc.test(line)) current = "doc";
  else if ((m = line.match(resultLine))) {
    if (current === null) continue; // stray result line; ignore
    if (results.has(current)) {
      fail(`binary '${current}' reported two result lines; log is malformed`);
    }
    results.set(current, {
      ok: m[1] === "ok",
      passed: Number(m[2]),
      failed: Number(m[3]),
      ignored: Number(m[4]),
    });
    current = null;
  }
}

const errors = [];
function fail(msg) {
  errors.push(msg);
}

let totalPassed = 0;
const rows = [];
for (const name of expected.sort()) {
  const r = results.get(name);
  const quarantined = Object.prototype.hasOwnProperty.call(QUARANTINE, name);
  if (!r) {
    fail(
      `test binary '${name}' produced NO result line -- it did not run. ` +
        `A suite that silently stops executing is the exact failure mode this job exists to catch.`
    );
    rows.push([name, "DID NOT RUN", "-", "-", "-"]);
    continue;
  }
  rows.push([
    name,
    quarantined ? "QUARANTINED" : r.ok ? "ok" : "FAILED",
    r.passed,
    r.failed,
    r.ignored,
  ]);
  if (r.ignored > 0) {
    fail(
      `'${name}' reports ${r.ignored} ignored test(s). The run must use ` +
        `--include-ignored; a nonzero ignored count means the flag was lost ` +
        `and the artifact suites did not execute.`
    );
  }
  if (quarantined) {
    if (r.failed === 0 && r.ok) {
      fail(
        `quarantined binary '${name}' PASSED. Remove it from QUARANTINE in ` +
          `scripts/ci/assert-test-counts.mjs -- a fix may not coexist with a ` +
          `stale expected-fail entry. (Reason it was quarantined: ${QUARANTINE[name]})`
      );
    }
    continue; // quarantined tests never count toward the floor
  }
  if (r.failed > 0) fail(`'${name}': ${r.failed} test(s) failed`);
  if (r.passed === 0) {
    fail(
      `'${name}': 0 tests passed. A binary reporting zero executed tests is ` +
        `treated as a broken suite, not a clean one.`
    );
  }
  totalPassed += r.passed;
}

// Quarantine entries must refer to real, still-present test files.
for (const name of Object.keys(QUARANTINE)) {
  if (!expected.includes(name)) {
    fail(
      `QUARANTINE names '${name}' but programs/burner/tests/${name}.rs does ` +
        `not exist -- remove the stale entry.`
    );
  }
}

if (totalPassed < minTotal) {
  fail(
    `total passed (non-quarantined) = ${totalPassed}, below the floor ` +
      `MIN_EXECUTED_TESTS=${minTotal}. The executed-test count DROPPED. If ` +
      `tests were legitimately removed, lower the floor in the workflow with ` +
      `a written reason; otherwise a suite has silently shrunk.`
  );
}

// Doc-tests are recorded but carry no >=1 requirement (the crate may have 0).
const doc = results.get("doc");
if (doc && doc.failed > 0) fail(`doc-tests: ${doc.failed} failed`);
if (doc) rows.push(["doc-tests", doc.ok ? "ok" : "FAILED", doc.passed, doc.failed, doc.ignored]);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
console.log(pad("binary", 30) + pad("status", 14) + pad("passed", 8) + pad("failed", 8) + "ignored");
for (const [n, st, p, f, i] of rows) {
  console.log(pad(n, 30) + pad(st, 14) + pad(p, 8) + pad(f, 8) + i);
}
console.log(`\ntotal passed (non-quarantined): ${totalPassed} (floor ${minTotal})`);
const quarantineNote = Object.entries(QUARANTINE)
  .map(([n, why]) => `  - ${n}: ${why}`)
  .join("\n");
if (quarantineNote) {
  console.log(`\nQUARANTINED (expected-fail, needs an owner decision):\n${quarantineNote}`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  let md = `### Burner test counts\n\n| binary | status | passed | failed | ignored |\n|---|---|---|---|---|\n`;
  for (const [n, st, p, f, i] of rows) md += `| ${n} | ${st} | ${p} | ${f} | ${i} |\n`;
  md += `\n**Total passed (non-quarantined): ${totalPassed}** (floor ${minTotal})\n`;
  if (quarantineNote) md += `\n**Quarantined (expected-fail):**\n${quarantineNote}\n`;
  if (errors.length) md += `\n**FAILURES:**\n${errors.map((e) => `- ${e}`).join("\n")}\n`;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

if (errors.length) {
  console.error(`\nFAIL: ${errors.length} problem(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("\nOK: every binary ran, nothing ignored, nothing failed, floor met.");
