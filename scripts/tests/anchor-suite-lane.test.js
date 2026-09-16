/**
 * Guard: a CI lane RUNS the Anchor suite, it is not the release-certification
 * workflow, it never touches a real cluster, and the eviction test is still in
 * the file it runs.
 *
 * THIS FILE USED TO PIN THE OPPOSITE FACT. Until 2026-09-15 it asserted that
 * NO lane ran `tests/turf_vault.ts` and none even read it, and it named the doc
 * sections to rewrite on the day that stopped being true. That day is this
 * change: `.github/workflows/anchor-suite.yml` boots a validator, loads the
 * built program at its declared address and executes the suite. The guard was
 * not deleted with the claim it protected — it was INVERTED, because the fact
 * worth pinning is the same fact either way: whether the suite runs, stated in
 * a lane rather than in prose an operator reads before a mainnet upgrade.
 *
 * WHAT IT PINS NOW, and each is a separate failure with its own message:
 *
 *   1. A LANE RUNS THE SUITE. Deleting the lane, or renaming the invocation out
 *      from under it, reddens this test rather than quietly restoring the old
 *      blind spot.
 *   2. THAT LANE IS NOT `CI`. Release::AcceptedCertification resolves an app
 *      repo's suite workflow by the literal workflow NAME "CI" and refuses to
 *      promote `accepted` when it is not green. Moving a validator lane into
 *      that workflow makes one flaky runner block the release sweep for the
 *      whole ecosystem — and a `paths:` filter there is refused outright by
 *      PATH_FILTER_KEYS. The split is load-bearing, so it is asserted.
 *   3. THE EVICTION TEST IS STILL THERE. `THE EVICTION: three personal wallets
 *      remove the agent-reachable slots` is the case the five-signer design
 *      exists for: it rotates to a five-signer set, reads VaultState back off
 *      chain, and proves by NEGATIVE assertion that the two agent-reachable
 *      keys can no longer pause the vault. A lane that runs a suite the case
 *      has been renamed or deleted out of is a lane guarding nothing, and
 *      nothing else in this repo would notice.
 *   4. THE WORKFLOW DECLARES ITS TRIGGER. The lane's value depends on WHEN it
 *      runs; a trigger silently narrowed to `workflow_dispatch` would look
 *      healthy and cover nothing.
 *   5. THE TWO PATH LISTS AGREE. GitHub Actions rejects YAML anchors, so the
 *      pull_request and push filters are written out twice by hand.
 *   6. THE PINNED ANCHOR CLI MATCHES `anchor-lang`. A CLI from another minor
 *      emits a different IDL, so the suite would drive something other than
 *      what the program declares.
 *   7. NO WORKFLOW CONTACTS A REAL CLUSTER OR READS A SECRET. The suite lane is
 *      the first CI job in this repo to run a validator at all, which is
 *      exactly when "CI never holds a keypair or spends SOL" stops being
 *      self-evident and starts needing a test. The program keypair for
 *      EQGFJAc… is a secret that must never reach a runner; the lane works
 *      without one by loading the `.so` at the declared address at genesis.
 *
 * IT ASSERTS FACTS, NOT PROSE. Every check below reads `.github/workflows/`,
 * `Anchor.toml`, `Cargo.toml` or the suite file itself. The one test that reads
 * prose is labelled a POINTER check and exists so this guard's own citations
 * cannot rot — the same disease it was written to treat.
 *
 * THE COMMENT STRIPPER IS LOAD-BEARING. `anchor` appears in these workflows
 * inside long comments arguing about lanes, and a trailing `# … anchor test …`
 * comment can sit inside a `run:` value. A guard that does not strip comments
 * matches prose and is green (or red) for the wrong reason. "control: the
 * comment stripper is load-bearing" fails if stripComments() is blanked.
 *
 * IT CANNOT PASS VACUOUSLY. "control: the step extractor sees the real lanes"
 * asserts the extracted surface still contains CI's four substantive steps AND
 * the suite invocation, so an extractor that returned nothing would fail rather
 * than report success.
 *
 * Pure Node stdlib (node:test + node:assert), no dependency tree — so it runs
 * in CI's `guards` lane, which deliberately installs nothing.
 *
 *   npm run test:scripts
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");
const WORKFLOWS_REL = ".github/workflows";
const SUITE_PATH = "tests/turf_vault.ts";
const SUITE_WORKFLOW_REL = WORKFLOWS_REL + "/anchor-suite.yml";
const CERT_WORKFLOW_NAME = "CI";

// The title of the case this whole lane exists to keep honest. Matched as a
// substring of an `it(` title so a reworded tail does not redden it, but a
// rename or a delete does.
const EVICTION_TITLE = "THE EVICTION: three personal wallets remove the agent-reachable slots";

// Invocations that EXECUTE the suite. `anchor test` resolves through
// Anchor.toml's [scripts] test, which is ts-mocha over "tests/**/*.ts".
const SUITE_RUNNERS = [
  /\banchor\s+(?:run\s+)?test\b/i,
  /\bts-mocha\b/i,
  /\bmocha\b/i,
];

// Bare mentions, for the stripper control only. These appear in comments.
const SUITE_MENTIONS = [/\bts-mocha\b/i, /\bmocha\b/i];

// A real cluster, in any spelling a step could reach one by. `localhost` and
// `127.0.0.1` are deliberately absent: the suite lane's whole point is a
// validator on the loopback.
const REAL_CLUSTER_PATTERNS = [
  /api\.devnet\.solana\.com/i,
  /api\.mainnet-beta\.solana\.com/i,
  /api\.testnet\.solana\.com/i,
  /\bhelius\b/i,
  /--url[= ]\s*(?:d(?:evnet)?|m(?:ainnet-beta)?|t(?:estnet)?)\b/i,
  /--provider\.cluster[= ]\s*(?:devnet|mainnet|mainnet-beta|testnet)\b/i,
];

// Sections that describe the lane. Cited in the failure messages, and verified
// to still exist by the POINTER test below.
const LANE_SECTIONS = [
  ["docs/VERIFICATION_MATRIX.md", "## The Lane That Runs This Suite"],
  ["docs/VERIFICATION_MATRIX.md", "### What it does not cover"],
  ["docs/VERIFICATION_MATRIX.md", "### Keeping it armed"],
  ["README.md", "### Continuous integration"],
];

function workflowFiles() {
  if (!fs.existsSync(WORKFLOWS_DIR)) return [];
  return fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort()
    .map((name) => ({
      rel: WORKFLOWS_REL + "/" + name,
      source: fs.readFileSync(path.join(WORKFLOWS_DIR, name), "utf8"),
    }));
}

function readRepoFile(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

/**
 * Remove YAML comments, quote-aware, preserving line numbers.
 *
 * LOAD-BEARING. A `#` inside quotes is data, not a comment, and a `#` must be
 * at line start or preceded by whitespace to open one.
 */
function stripComments(source) {
  return source.split("\n").map((raw, index) => {
    let out = "";
    let quote = null;
    for (let i = 0; i < raw.length; i += 1) {
      const ch = raw[i];
      if (quote) {
        out += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        out += ch;
        continue;
      }
      if (ch === "#" && (i === 0 || /\s/.test(raw[i - 1]))) break;
      out += ch;
    }
    return { number: index + 1, text: out };
  });
}

/**
 * The executable surface: every `run:` command and every `uses:` action,
 * including multi-line block scalars (`run: |`).
 */
function executableSteps(lines) {
  const steps = [];
  let block = null;
  for (const line of lines) {
    if (block) {
      if (line.text.trim() === "") continue;
      const indent = line.text.length - line.text.trimStart().length;
      if (indent > block.indent) {
        steps.push({ number: line.number, text: line.text.trim() });
        continue;
      }
      block = null;
    }
    const match = line.text.match(/^(\s*)(-\s+)?(run|uses):\s*(.*)$/);
    if (!match) continue;
    const value = match[4].trim();
    const indent = match[1].length + (match[2] ? match[2].length : 0);
    if (/^[|>][+-]?\d*$/.test(value)) {
      block = { indent: indent };
      continue;
    }
    if (value) steps.push({ number: line.number, text: value });
  }
  return steps;
}

function packageScripts() {
  const file = path.join(REPO_ROOT, "package.json");
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")).scripts || {};
}

function anchorTestScript() {
  const file = path.join(REPO_ROOT, "Anchor.toml");
  if (!fs.existsSync(file)) return null;
  const section = fs
    .readFileSync(file, "utf8")
    .split(/^\[/m)
    .find((chunk) => chunk.startsWith("scripts]"));
  if (!section) return null;
  const match = section.match(/^\s*test\s*=\s*"((?:[^"\\]|\\.)*)"/m);
  return match ? match[1].replace(/\\"/g, '"') : null;
}

/**
 * Resolve one command into every command it actually causes to run:
 * `npm run <script>` / `yarn <script>` through package.json, and `anchor test`
 * through Anchor.toml. Returns the chain so a failure can show the whole path.
 */
function resolveChain(command) {
  const chain = [{ label: null, text: command }];
  const scripts = packageScripts();

  const npmRun = command.match(
    /\b(?:npm|pnpm)\s+(?:run|run-script)\s+([\w:.-]+)/i
  );
  const npmBare = command.match(/\b(?:npm|pnpm)\s+(test|start)\b/i);
  const yarnRun = command.match(/\byarn\s+(?:run\s+)?([\w:.-]+)/i);
  const name =
    (npmRun && npmRun[1]) ||
    (npmBare && npmBare[1]) ||
    (yarnRun && yarnRun[1]) ||
    null;

  if (name && Object.prototype.hasOwnProperty.call(scripts, name)) {
    chain.push({ label: "package.json scripts." + name, text: scripts[name] });
  }

  if (chain.some((link) => /\banchor\s+(?:run\s+)?test\b/i.test(link.text))) {
    const anchorScript = anchorTestScript();
    if (anchorScript) {
      chain.push({ label: "Anchor.toml [scripts] test", text: anchorScript });
    }
  }

  return chain;
}

/** Every step, in every workflow, whose resolved chain matches a pattern. */
function findMatches(patterns) {
  const hits = [];
  for (const workflow of workflowFiles()) {
    const steps = executableSteps(stripComments(workflow.source));
    for (const step of steps) {
      const chain = resolveChain(step.text);
      const matched = patterns.find((pattern) =>
        chain.some((link) => pattern.test(link.text))
      );
      if (matched) {
        hits.push({ file: workflow.rel, line: step.number, chain: chain });
      }
    }
  }
  return hits;
}

function describe(hits) {
  return hits
    .map((hit) => {
      const lines = [`  ${hit.file}:${hit.line}`];
      for (const link of hit.chain) {
        lines.push(
          link.label
            ? `      -> ${link.label}: ${link.text}`
            : `      ${link.text}`
        );
      }
      return lines.join("\n");
    })
    .join("\n");
}

/** A workflow's declared `name:` — the key the release guard resolves on. */
function workflowName(source) {
  for (const line of stripComments(source)) {
    const match = line.text.match(/^name:\s*(.+?)\s*$/);
    if (match) return match[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

/**
 * The `on:` block of a workflow, as raw lines. YAML's `on` is famously parsed
 * as the boolean `true` by loose readers, so this reads text rather than
 * pretending to be a YAML parser.
 */
function triggerBlock(source) {
  const lines = stripComments(source).map((line) => line.text);
  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (start === -1) return null;
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (/^\S/.test(line)) break;
    block.push(line);
  }
  return block;
}

/** The `paths:` lists in a workflow's trigger block, in order. */
function pathFilters(block) {
  const lists = [];
  let current = null;
  for (const line of block) {
    const indent = line.length - line.trimStart().length;
    if (/^\s*paths:\s*$/.test(line)) {
      current = { indent: indent, entries: [] };
      lists.push(current);
      continue;
    }
    if (!current) continue;
    const entry = line.match(/^\s*-\s*(.+?)\s*$/);
    if (entry && indent > current.indent) {
      current.entries.push(entry[1].replace(/^["']|["']$/g, ""));
      continue;
    }
    if (indent <= current.indent) current = null;
  }
  return lists.map((list) => list.entries);
}

test("a CI lane runs the Anchor suite", () => {
  const hits = findMatches(SUITE_RUNNERS);

  assert.ok(
    hits.length > 0,
    [
      "",
      `NO workflow step runs ${SUITE_PATH} any more.`,
      "",
      "That is the state this repo was in until 2026-09-15, and the reason this",
      "file exists: the suite holds the only assertions that ever EXECUTE the",
      `program, "${EVICTION_TITLE}"`,
      "among them, and nothing else in CI would notice one of them breaking.",
      "",
      `Restore the lane in ${SUITE_WORKFLOW_REL}, or — if the lane is being`,
      "retired deliberately — rewrite these sections in the SAME change and",
      "invert this guard back, rather than deleting it:",
      LANE_SECTIONS.map(([file, heading]) => `  ${file}  ${heading}`).join("\n"),
      "",
    ].join("\n")
  );

  const files = [...new Set(hits.map((hit) => hit.file))];
  assert.deepEqual(
    files,
    [SUITE_WORKFLOW_REL],
    [
      "",
      `The suite is run from somewhere other than ${SUITE_WORKFLOW_REL}:`,
      "",
      describe(hits),
      "",
      "Keep it in one place. The lane is slow and validator-backed; a second",
      "copy of it doubles the flake surface and the runner bill, and one of the",
      "two will rot.",
      "",
    ].join("\n")
  );
});

test("the workflow the release guard reads does NOT run the suite", () => {
  const offenders = [];
  for (const workflow of workflowFiles()) {
    if (workflowName(workflow.source) !== CERT_WORKFLOW_NAME) continue;
    for (const step of executableSteps(stripComments(workflow.source))) {
      const chain = resolveChain(step.text);
      if (
        SUITE_RUNNERS.some((pattern) =>
          chain.some((link) => pattern.test(link.text))
        )
      ) {
        offenders.push({ file: workflow.rel, line: step.number, chain: chain });
      }
    }
  }

  assert.deepEqual(
    offenders.map((hit) => `${hit.file}:${hit.line}`),
    [],
    [
      "",
      `The workflow named "${CERT_WORKFLOW_NAME}" now runs the Anchor suite:`,
      "",
      describe(offenders),
      "",
      "Release::AcceptedCertification resolves an app repo's suite workflow by",
      `that literal NAME and refuses to promote \`accepted\` unless it is green.`,
      "A validator lane is the flakiest thing in this repo — network installs, a",
      "local validator, ~10 minutes of wall clock — so one bad runner would block",
      "`bin/release prepare` for the whole ecosystem. It also cannot carry the",
      "`paths:` filter the suite lane needs: PATH_FILTER_KEYS refuses a filtered",
      "suite workflow outright.",
      "",
      `Keep the suite in ${SUITE_WORKFLOW_REL}, which certifies nothing on the`,
      "release path and is free to be slow and filtered.",
      "",
    ].join("\n")
  );
});

test("the eviction test is still in the suite the lane runs", () => {
  const source = readRepoFile(SUITE_PATH);
  const titled = source
    .split("\n")
    .some((line) => line.includes(EVICTION_TITLE) && /\bit\s*\(/.test(line));

  assert.ok(
    titled,
    [
      "",
      `${SUITE_PATH} no longer contains an it() titled:`,
      "",
      `  ${EVICTION_TITLE}`,
      "",
      "That case is why the lane in this repo is worth ten minutes of validator",
      "time. It rotates the vault to a five-signer set, reads VaultState back OFF",
      "CHAIN, and proves by NEGATIVE assertion that the two agent-reachable keys",
      "can no longer pause the vault — the doomsday property the five-signer",
      "design exists for.",
      "",
      "If it was renamed, update EVICTION_TITLE here in the same change. If it",
      "was deleted, say in docs/VERIFICATION_MATRIX.md what covers the property",
      "now, because a lane running a suite without it guards materially less.",
      "",
    ].join("\n")
  );

  // The lane runs `anchor test`, which resolves to Anchor.toml's [scripts]
  // test. A glob narrowed away from tests/ would leave the case above sitting
  // in a file nothing executes, with every test in this file still green.
  const script = anchorTestScript();
  assert.ok(
    script && /tests\/\*\*|tests\/\*|tests\//.test(script),
    [
      "",
      "Anchor.toml's [scripts] test no longer globs tests/:",
      "",
      `  ${script === null ? "(no [scripts] test entry)" : script}`,
      "",
      `So \`anchor test\` would not reach ${SUITE_PATH}, and the lane would be`,
      "green over a suite it never ran.",
      "",
    ].join("\n")
  );
});

test("the Anchor suite workflow declares its trigger", () => {
  const source = readRepoFile(SUITE_WORKFLOW_REL);
  const block = triggerBlock(source);

  assert.ok(
    block && block.length > 0,
    `${SUITE_WORKFLOW_REL} has no \`on:\` block — it would never run at all`
  );

  const text = block.join("\n");
  const required = [
    [
      /^\s{2}pull_request:/m,
      "pull_request — the coverage that matters: a program or suite change is judged before it merges",
    ],
    [
      /^\s{2}push:/m,
      "push — `accepted` carries a COMBINATION of changes no PR run ever executed, and that is the rung `bin/release prepare` promotes",
    ],
    [
      /^\s{2}schedule:/m,
      "schedule — the belt. Every other trigger is change-driven, so a quiet week would leave the eviction test unrun and the repo back on a stamp somebody took once",
    ],
    [
      /^\s{2}workflow_dispatch:/m,
      "workflow_dispatch — the rollout gate's hand: docs/VERIFICATION_MATRIX.md makes a clean-machine suite run leg 3 of the control before a Squads upgrade",
    ],
  ];
  const missing = required
    .filter(([pattern]) => !pattern.test(text))
    .map(([, why]) => "  " + why);

  assert.deepEqual(
    missing,
    [],
    [
      "",
      `${SUITE_WORKFLOW_REL} dropped trigger(s) this lane's coverage rests on:`,
      "",
      missing.join("\n"),
      "",
      "A lane narrowed to fewer triggers still reports green — it just covers",
      "less, silently. Narrow it deliberately if you must, and say so in the",
      "workflow's header comment and in this list.",
      "",
    ].join("\n")
  );

  assert.match(
    text,
    /^\s{4}branches:\s*\[.*\baccepted\b.*\]/m,
    [
      "",
      `${SUITE_WORKFLOW_REL}'s push trigger no longer covers \`accepted\`.`,
      "",
      "Review merges approved PRs onto `accepted`, and that tree — not any",
      "individual PR head — is what the release sweep promotes. Without this",
      "branch the integrated combination is never executed.",
      "",
    ].join("\n")
  );
});

test("the pull_request and push path filters are identical", () => {
  const block = triggerBlock(readRepoFile(SUITE_WORKFLOW_REL));
  const filters = pathFilters(block);

  assert.equal(
    filters.length,
    2,
    [
      "",
      `Expected exactly two \`paths:\` lists in ${SUITE_WORKFLOW_REL} (one under`,
      `pull_request, one under push); found ${filters.length}.`,
      "",
      "Both triggers must be filtered to the same set: a filter on only one of",
      "them means the PR run and the `accepted` run disagree about when the",
      "suite matters.",
      "",
    ].join("\n")
  );

  assert.deepEqual(
    filters[1],
    filters[0],
    [
      "",
      `The two \`paths:\` lists in ${SUITE_WORKFLOW_REL} have drifted apart:`,
      "",
      `  pull_request: ${JSON.stringify(filters[0])}`,
      `  push:         ${JSON.stringify(filters[1])}`,
      "",
      "They are written out twice because GitHub Actions REJECTS YAML anchors",
      "(`&suite_paths` / `*suite_paths` does not parse), so the dedup has to be",
      "this test instead. Add the path to both lists.",
      "",
    ].join("\n")
  );

  for (const required of ["programs/**", "tests/**", "Anchor.toml"]) {
    assert.ok(
      filters[0].includes(required),
      `${SUITE_WORKFLOW_REL}'s path filter no longer covers ${required} — a change there would not run the suite`
    );
  }

  assert.ok(
    filters[0].includes(".github/workflows/anchor-suite.yml"),
    [
      "",
      `${SUITE_WORKFLOW_REL}'s path filter no longer includes the workflow`,
      "itself, so a PR that edits the lane would not run the lane. Every change",
      "to this file should be judged by a run of it.",
      "",
    ].join("\n")
  );
});

test("the pinned anchor CLI matches the program's anchor-lang", () => {
  const workflow = readRepoFile(SUITE_WORKFLOW_REL);
  const pinned = workflow.match(/^\s*ANCHOR_VERSION:\s*"?([\d.]+)"?\s*$/m);

  assert.ok(
    pinned,
    [
      "",
      `${SUITE_WORKFLOW_REL} no longer pins ANCHOR_VERSION.`,
      "",
      "An unpinned CLI lets an upstream release redden this lane on a tree",
      "nobody touched — the flake that gets a lane ignored, which is worse than",
      "not having one.",
      "",
    ].join("\n")
  );

  const cargo = readRepoFile("programs/turf_vault/Cargo.toml");
  const lang = cargo.match(/^\s*anchor-lang\s*=\s*\{?\s*version\s*=\s*"([\d.]+)"/m);

  assert.ok(lang, "could not read anchor-lang's version from programs/turf_vault/Cargo.toml");

  assert.equal(
    pinned[1],
    lang[1],
    [
      "",
      "The Anchor CLI the suite lane installs disagrees with the program's",
      "anchor-lang dependency:",
      "",
      `  ${SUITE_WORKFLOW_REL}  ANCHOR_VERSION: ${pinned[1]}`,
      `  programs/turf_vault/Cargo.toml  anchor-lang = ${lang[1]}`,
      "",
      "A CLI from another minor emits a different IDL and can disagree about",
      "account discriminators, so `anchor build` in CI would produce something",
      "the program does not declare and the suite would be driving it. Bump both",
      "together.",
      "",
    ].join("\n")
  );
});

test("no workflow contacts a real cluster or reads a secret", () => {
  const offenders = [];
  const secrets = [];

  for (const workflow of workflowFiles()) {
    const lines = stripComments(workflow.source);
    // EVERY line, not just `run:` steps. The suite lane's cluster target lives in
    // `env: RPC_URL` and no step spells it out — every step says "$RPC_URL" — so a
    // step-only scan stays GREEN on the one-line edit that repoints this validator
    // lane at devnet, which is the single most likely way this property breaks.
    // The secrets scan below already reads `lines` for exactly that reason; the two
    // halves of this test now agree on their surface. Comments are stripped first,
    // so the workflows' long prose about devnet and mainnet cannot false-positive.
    for (const line of lines) {
      const matched = REAL_CLUSTER_PATTERNS.find((pattern) =>
        pattern.test(line.text)
      );
      if (matched) {
        offenders.push(`  ${workflow.rel}:${line.number}  ${line.text.trim()}`);
      }
    }
    for (const line of lines) {
      if (/secrets\.(?!GITHUB_TOKEN\b)\w+/.test(line.text)) {
        secrets.push(`  ${workflow.rel}:${line.number}  ${line.text.trim()}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    [
      "",
      "A workflow names a REAL Solana cluster:",
      "",
      offenders.join("\n"),
      "",
      "CI in this repo contacts nothing but a loopback validator it started",
      "itself. A runner that can reach devnet or mainnet is a runner that can",
      "spend SOL and mutate a live vault on a bad merge.",
      "",
    ].join("\n")
  );

  assert.deepEqual(
    secrets,
    [],
    [
      "",
      "A workflow now reads a repository secret:",
      "",
      secrets.join("\n"),
      "",
      "The one secret this lane could plausibly want is the program keypair for",
      "the declared program ID, and it must NEVER be given one: `anchor build`",
      "on a fresh checkout generates a random keypair, so the lane instead loads",
      "the built `.so` at the DECLARED address with",
      "`solana-test-validator --upgradeable-program`, and needs no key at all.",
      "If a secret is genuinely required, say what for in the workflow header and",
      "update this guard deliberately.",
      "",
    ].join("\n")
  );
});

test("control: the comment stripper is load-bearing", () => {
  const workflows = workflowFiles();
  assert.ok(
    workflows.length > 0,
    `no workflow files found under ${WORKFLOWS_REL}/ - this guard is inert`
  );

  const raw = [];
  const stripped = [];
  for (const workflow of workflows) {
    const strippedText = stripComments(workflow.source)
      .map((line) => line.text)
      .join("\n");
    for (const pattern of SUITE_MENTIONS) {
      if (pattern.test(workflow.source)) raw.push(`${workflow.rel} ${pattern}`);
      if (pattern.test(strippedText)) {
        stripped.push(`${workflow.rel} ${pattern}`);
      }
    }
  }

  assert.ok(
    raw.length > 0,
    [
      "",
      `No commented mention of ts-mocha survives under ${WORKFLOWS_REL}/, so the`,
      "stripper removes nothing here and every scan above would pass whether or",
      "not it works. Point SUITE_MENTIONS at a token the workflows really do",
      "carry in a comment, or retire this control deliberately.",
      "",
    ].join("\n")
  );

  assert.deepEqual(
    stripped,
    [],
    [
      "",
      "A commented-only token survived comment stripping:",
      "",
      stripped.map((hit) => `  ${hit}`).join("\n"),
      "",
      "Either stripComments() stopped working — in which case the scans above",
      "are matching prose rather than commands — or a workflow gained a real,",
      "uncommented ts-mocha invocation, which should be `anchor test` so the",
      "Anchor.toml [scripts] entry stays the single declaration of the suite.",
      "",
    ].join("\n")
  );
});

test("control: the step extractor sees the real lanes", () => {
  const steps = [];
  for (const workflow of workflowFiles()) {
    for (const step of executableSteps(stripComments(workflow.source))) {
      steps.push(step.text);
    }
  }

  // CI's four substantive steps plus the suite invocation. An extractor that
  // silently returned nothing would make every scan above pass vacuously; this
  // is what stops that.
  const expected = [
    /\bcargo check\b/,
    /\bcargo clippy\b/,
    /\bcargo test\b/,
    /\bnpm run check:doc-op-refs\b/,
    /\bnpm run test:scripts\b/,
    /\banchor test\b/,
    /\bsolana-test-validator\b/,
  ];
  const missing = expected.filter(
    (pattern) => !steps.some((step) => pattern.test(step))
  );

  assert.deepEqual(
    missing,
    [],
    [
      "",
      "The step extractor no longer sees CI's substantive steps:",
      "",
      missing.map((pattern) => `  ${pattern}`).join("\n"),
      "",
      `It extracted ${steps.length} step(s) in total. If CI genuinely dropped a`,
      "step, update this control AND the CI tables in README.md and",
      "docs/VERIFICATION_MATRIX.md. If CI still runs it, executableSteps() is",
      "broken and every scan in this file is passing vacuously.",
      "",
    ].join("\n")
  );
});

test("pointer: the sections this guard cites still exist", () => {
  // The ONLY prose-reading test here, and deliberately separate from the facts.
  // Rewording a heading must not redden a fact — the fact has not changed — but
  // it MUST redden something, or this guard's failure messages quietly start
  // citing headings that no longer exist. That is the same stale-pointer
  // disease this guard was written to treat.
  const seen = new Set();
  const missing = [];

  for (const [file, heading] of LANE_SECTIONS) {
    const key = file + " " + heading;
    if (seen.has(key)) continue;
    seen.add(key);

    const full = path.join(REPO_ROOT, file);
    if (!fs.existsSync(full)) {
      missing.push(`${file} (file not found)  ${heading}`);
      continue;
    }
    const found = fs
      .readFileSync(full, "utf8")
      .split("\n")
      .some((line) => line.trim() === heading);
    if (!found) missing.push(`${file}  ${heading}`);
  }

  assert.deepEqual(
    missing,
    [],
    [
      "",
      "This guard's failure messages cite headings that no longer exist:",
      "",
      missing.map((entry) => `  ${entry}`).join("\n"),
      "",
      "The FACTS above are unaffected — a reword changes no lane. But a guard",
      "that names a section an operator cannot find is the next stale pointer.",
      "Update LANE_SECTIONS in this file to the new headings.",
      "",
    ].join("\n")
  );
});
