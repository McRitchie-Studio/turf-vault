/**
 * Guard: docs/vault-console.html builds the bytes it claims to build.
 *
 * WHY THIS EXISTS. The console is a standalone operator tool with NO dependency
 * tree — no npm at run time, no CDN, no bundler. Every primitive it needs to
 * reach Solana (base58, SHA 256, the ed25519 on-curve test, PDA derivation,
 * borsh decoding, transaction message serialization) is written out inside that
 * one HTML file. That is the right call for a tool meant to open from a USB
 * stick on a borrowed laptop, and it is exactly why it needs a gate: hand
 * rolled crypto and wire-format code that nothing checks is how an operator
 * ends up staring at a decoded proposal that says something the chain does not.
 *
 * IT TESTS THE SHIPPED FILE, NOT A COPY. `loadCore()` reads docs/vault-console.html
 * off disk, cuts out the `<script id="console-core">` block, and evaluates THAT.
 * There is no second copy of the logic in this repo to drift from — the bytes CI
 * proves here are the bytes an operator opens. If the block is renamed, moved,
 * or stops evaluating, this suite fails rather than silently testing nothing.
 *
 * PURE NODE STDLIB. CI's `guards` lane installs no dependency tree
 * (.github/workflows/ci.yml says so, deliberately), so everything here runs on
 * `node:test`, `node:assert` and `node:crypto`. That is not a limitation for
 * this suite — `node:crypto` IS the independent implementation of SHA 256, and
 * the Anchor discriminators are recomputed from their instruction names rather
 * than copied, so the literals in the console are checked against their
 * definition rather than against themselves.
 *
 * WHAT MAKES IT EVIDENCE RATHER THAN DECORATION:
 *
 *   1. THE GOLDEN VECTORS CAME FROM THE REFERENCE IMPLEMENTATION. Every
 *      expected PDA, instruction and serialized message below was produced by
 *      @solana/web3.js and @sqds/multisig and diffed byte for byte before being
 *      written down (2026-09-15). They are not the console's own output frozen
 *      into an assertion, which would certify nothing.
 *   2. THE ACCOUNT FIXTURES ARE REAL CHAIN BYTES. The Squads accounts below
 *      were captured from devnet, base64 exactly as an RPC returns them. The
 *      decoders are therefore tested against what the chain actually emits —
 *      including a 43-character pubkey, which is the case a base58 encoder with
 *      broken leading-zero handling gets wrong.
 *   3. IT PROVES THE REFUSALS BITE. A decoder that accepts anything, and a
 *      "refuses to send what it has not displayed" digest that never differs,
 *      are worth nothing. Controls below feed each one input it must reject.
 *   4. THE OPTIONAL LANE CROSS-CHECKS AGAINST web3.js LIVE when node_modules
 *      happens to be present, and self-skips when it is not — the same shape
 *      scripts/tests/mainnet-config.test.js established in this repo.
 *
 *   npm run test:scripts
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPTS_DIR = path.join(ROOT, "scripts");
const CONSOLE_HTML = path.join(ROOT, "docs", "vault-console.html");
const CORE_SCRIPT_ID = "console-core";

// ── loading the shipped file ────────────────────────────────────────────────

function consoleHtml() {
  return fs.readFileSync(CONSOLE_HTML, "utf8");
}

/**
 * Cut the core block out of the shipped HTML and evaluate it.
 *
 * The block ends by assigning `VaultConsoleCore`, which is a plain global in a
 * browser and is returned here. Nothing in the block touches the DOM, `window`
 * or the network — that separation is what makes this possible, and the first
 * test below asserts it still holds.
 */
function loadCore() {
  const html = consoleHtml();
  const openTag = `<script id="${CORE_SCRIPT_ID}">`;
  const open = html.indexOf(openTag);
  assert.notEqual(open, -1, `docs/vault-console.html no longer has <script id="${CORE_SCRIPT_ID}">`);
  const start = open + openTag.length;
  const end = html.indexOf("</script>", start);
  assert.notEqual(end, -1, "the console-core script block is unterminated");
  const src = html.slice(start, end);
  return new Function(`${src}\n;return VaultConsoleCore;`)();
}

const bytes = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));
const toHex = (arr) => Buffer.from(arr).toString("hex");
const fromB64 = (b64) => Uint8Array.from(Buffer.from(b64, "base64"));

// ── fixtures ────────────────────────────────────────────────────────────────

const DEVNET_PROGRAM = "EQGFJAcABtDb6VXtiijTjZ6cE2UqdvhnqJvoharJbpMJ";
const MAINNET_PROGRAM = "DaFv83yokwTz8msP9CzJ13eazSGk15NuUTxjkfzJzxMM";
const DEVNET_MULTISIG = "7nRuVw3VZFC6z85tYVDitPnaUHZCkqLpJRSTBNtPmtZB";
const SQUADS_PROGRAM = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";

/**
 * PDAs, each produced by PublicKey.findProgramAddressSync (and, for the Squads
 * pair, cross-checked against @sqds/multisig's own getProposalPda /
 * getTransactionPda) on 2026-09-15. The vault_state entry additionally matches
 * the address docs/CURRENT_DEPLOYMENT.md has recorded independently since
 * 2026-09-07, which is a third, human-maintained witness to the same number.
 */
const GOLDEN_PDA = {
  vaultStateDevnet: "J7b5g9uS5M2Nog1Ly1UATXTDMtXdpXK3JffRAHXGHkK2",
  governanceDevnet: "729Q8AVBSV4fovTk9G74aoLwH6eChZT4DESzVAoGVS8J",
  proposal16: "3qMdjBDiiXqRD5LScJdDU9UrZFoUpV9JGaHGf3CwyodN",
  transaction16: "4skEPRaxhC9e7x2JpEDobw4r8GogFHhBLL7CcWf1fGAc",
  proposal17: "Dppb1i7xm9D71SdZtRJaapDewjEpptBHgWu7oGJ4tg8Z",
  transaction17: "JDK6CBDZkhJVWyR5ujfKPUKgu9uhzvSWMb1Xdutpau3b",
  proposal18: "6QBHFVHiuZXYxF1NzppxkwGLQJZ95TDqzeCoYBv5cayC",
  transaction18: "BGqawjiDo21f1ViJhtkbCod8Ty9CoZQ6BLKWfqfWHdHF",
};

/**
 * Real devnet account data, base64 exactly as getAccountInfo returns it.
 *
 * TWO SNAPSHOTS OF THE SAME MULTISIG, taken either side of a real execution.
 * Proposal #18 executed on 2026-09-15 while this console was being built, which
 * makes the pair unusually good evidence: `multisigBefore` holds 4 members with
 * `staleTransactionIndex` 16, `multisigAfter` holds 5 with it moved to 18, and
 * the difference between them is EXACTLY the three actions
 * `configTransaction18` declares. A decoder that gets either one wrong cannot
 * make that story line up.
 *
 * It is also why the fixtures are frozen bytes rather than a live read: the
 * chain moves, and a suite that asserts against whatever is on devnet today
 * fails for reasons that have nothing to do with the code.
 */
const FIXTURE = {
  multisigBefore:
    "4HR5ukShT+zwpvUdvDG+7NbxMclEtzqpjJAeGefyl/+geYgdYZQ0zgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAEgAAAAAAAAAQAAAAAAAAAAD+BAAAACPLTGGE7WM17orZBOEuPCL7VDrflDgIRJGtjYZPo4y9B2Fmn4YEh/cmGVB43u70fvB/k6U+YRvdpjoYIyhATy/HB4DljKxROfwrYWOVCqmJJbvfpeIwZMuXhLYFUXF7yu+qB5mPYqeYSt7FegIso6cMva3wjScLtdmR+lHCm5IcQ+1SBwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  /** The SAME account after proposal #18 executed: 5 members, stale moved to 18. */
  multisigAfter:
    "4HR5ukShT+zwpvUdvDG+7NbxMclEtzqpjJAeGefyl/+geYgdYZQ0zgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAEgAAAAAAAAASAAAAAAAAAAD+BQAAABhoHVZ5X2eAp3G3we6Zb7XjCUKT1dmqbf/iwRMKqMhmByPLTGGE7WM17orZBOEuPCL7VDrflDgIRJGtjYZPo4y9B2Fmn4YEh/cmGVB43u70fvB/k6U+YRvdpjoYIyhATy/HB2ymMjaHmVnTkpX6C9wVSVq+YfcTCfn2RFlgiZ3JqlISB5mPYqeYSt7FegIso6cMva3wjScLtdmR+lHCm5IcQ+1SBwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  proposal18:
    "Gl69u3SINSFkyWsWeyoJOSDRe6jBW4DmVAyKy/thVJ6JMgYAeuqa1hIAAAAAAAAAARCeqWoAAAAA+wEAAACZj2KnmErexXoCLKOnDL2t8I0nC7XZkfpRwpuSHEPtUgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  configTransaction18:
    "XggEI3GLi3BkyWsWeyoJOSDRe6jBW4DmVAyKy/thVJ6JMgYAeuqa1pmPYqeYSt7FegIso6cMva3wjScLtdmR+lHCm5IcQ+1SEgAAAAAAAAD+AwAAAAAYaB1WeV9ngKdxt8HumW+14wlCk9XZqm3/4sETCqjIZgcAbKYyNoeZWdOSlfoL3BVJWr5h9xMJ+fZEWWCJncmqUhIHAYDljKxROfwrYWOVCqmJJbvfpeIwZMuXhLYFUXF7yu+q",
  proposal17:
    "Gl69u3SINSFkyWsWeyoJOSDRe6jBW4DmVAyKy/thVJ6JMgYAeuqa1hEAAAAAAAAAAYWHqWoAAAAA/AEAAACZj2KnmErexXoCLKOnDL2t8I0nC7XZkfpRwpuSHEPtUgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  /** Index 16 — the already-executed rotation. Six actions, all six kinds this
   *  console decodes except the two it deliberately does not, which makes it the
   *  fixture that proves the multi-action walk keeps its place. */
  configTransaction16:
    "XggEI3GLi3BkyWsWeyoJOSDRe6jBW4DmVAyKy/thVJ6JMgYAeuqa1mymMjaHmVnTkpX6C9wVSVq+YfcTCfn2RFlgiZ3JqlISEAAAAAAAAAD/BgAAAACZj2KnmErexXoCLKOnDL2t8I0nC7XZkfpRwpuSHEPtUgcAI8tMYYTtYzXuitkE4S48IvtUOt+UOAhEka2Nhk+jjL0HAIDljKxROfwrYWOVCqmJJbvfpeIwZMuXhLYFUXF7yu+qBwFspjI2h5lZ05KV+gvcFUlavmH3Ewn59kRZYImdyapSEgGyAxZTAeEPyuziVVLdQnNiod73F7JUM5m27PVJWZj24gIDAA==",
};

/**
 * Serialized transaction messages, each produced by @solana/web3.js's
 * Transaction.serializeMessage() and diffed against the console's output on
 * 2026-09-15. Blockhash is a fixed literal so the vectors are reproducible.
 */
const GOLDEN_BLOCKHASH = "9zHGqPBBmTkDGqPXD8CQhSpwGUgxRDZGUmsjPcWgAPEr";
const GOLDEN_PAYER = "BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo";
const GOLDEN_MESSAGE = {
  approve:
    "01000204998f62a7984adec57a022ca3a70cbdadf08d270bb5d991fa51c29b921c43ed52503a6ac4bb01ea12ac58750c33eae9fd94037410582ab32c732a41d58f60ac3764c96b167b2a093920d17ba8c15b80e6540c8acbfb61549e893206007aea9ad60681c4ce47e22368b8b1555ec887af092efc7efbb66ca3f52fbf68d4ac9cb7a8858a00606cd73d9cf8f02aba00accf1bd39ae93223a69293349594f1b13ed7f3010303020001099025a488bcd82af800",
  execute:
    "01000306998f62a7984adec57a022ca3a70cbdadf08d270bb5d991fa51c29b921c43ed52503a6ac4bb01ea12ac58750c33eae9fd94037410582ab32c732a41d58f60ac3764c96b167b2a093920d17ba8c15b80e6540c8acbfb61549e893206007aea9ad6000000000000000000000000000000000000000000000000000000000000000098a38453aff73ec8692535ce9dcb1054c71f7cb1d1aa6b8eeb5bf28d40dfc7ce0681c4ce47e22368b8b1555ec887af092efc7efbb66ca3f52fbf68d4ac9cb7a8858a00606cd73d9cf8f02aba00accf1bd39ae93223a69293349594f1b13ed7f3010506020001040003087292f4bdfc8c2428",
  both:
    "01000306998f62a7984adec57a022ca3a70cbdadf08d270bb5d991fa51c29b921c43ed52503a6ac4bb01ea12ac58750c33eae9fd94037410582ab32c732a41d58f60ac3764c96b167b2a093920d17ba8c15b80e6540c8acbfb61549e893206007aea9ad6000000000000000000000000000000000000000000000000000000000000000098a38453aff73ec8692535ce9dcb1054c71f7cb1d1aa6b8eeb5bf28d40dfc7ce0681c4ce47e22368b8b1555ec887af092efc7efbb66ca3f52fbf68d4ac9cb7a8858a00606cd73d9cf8f02aba00accf1bd39ae93223a69293349594f1b13ed7f3020503020001099025a488bcd82af8000506020001040003087292f4bdfc8c2428",
};

// ════════════════════════════════════════════════════════════════════════════
// The file itself
// ════════════════════════════════════════════════════════════════════════════

test("the console is one self-contained file with no external resource", () => {
  const html = consoleHtml();

  // No network dependency of any kind. A tool that opens from a USB stick on a
  // borrowed laptop cannot need a CDN to be reachable, and a page that silently
  // degrades when one is not is worse than one that never had it.
  assert.equal(/<script[^>]+\ssrc=/i.test(html), false, "the console loads an external script");
  assert.equal(/<link[^>]+\srel=["']?stylesheet/i.test(html), false, "the console loads an external stylesheet");
  assert.equal(/@import\s/i.test(html), false, "the console @imports a stylesheet");
  assert.equal(/cdnjs|jsdelivr|unpkg|esm\.sh|googleapis/i.test(html), false, "the console references a CDN");

  // It must say, in its own header, that file:// does not work — the failure is
  // otherwise silent (no window.solana, no error) and costs an operator the
  // worst ten minutes of a bad day.
  assert.match(html, /file:\/\//, "the console does not mention the file:// limitation");
  assert.match(html, /python3 -m http\.server/, "the console does not give the localhost recipe");
});

test("the core block is pure: no DOM, no window, no network", () => {
  const html = consoleHtml();
  const openTag = `<script id="${CORE_SCRIPT_ID}">`;
  const start = html.indexOf(openTag) + openTag.length;
  const src = html.slice(start, html.indexOf("</script>", start));

  // This is what lets the suite evaluate the block outside a browser at all. If
  // it ever stops holding, the suite would fail to load rather than quietly
  // stop covering the file, but naming the property is cheaper to debug.
  for (const forbidden of ["document.", "window.", "fetch(", "localStorage", "XMLHttpRequest"]) {
    assert.equal(src.includes(forbidden), false, `the core block reaches for ${forbidden}`);
  }
  assert.match(src, /TextEncoder/, "sanity: the core should still use TextEncoder");
});

test("the core block evaluates and exports what the UI uses", () => {
  const core = loadCore();
  for (const name of [
    "b58encode", "b58decode", "parsePubkey", "sha256", "findProgramAddress",
    "compileMessage", "assembleTransaction", "decodeMultisig", "decodeProposal",
    "decodeConfigTransaction", "ixProposalApprove", "ixConfigTransactionExecute",
    "ixUpdateSigners", "detectVaultShape", "readSignerSlots", "planDigest",
  ]) {
    assert.equal(typeof core[name], "function", `core.${name} is missing`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// base58
// ════════════════════════════════════════════════════════════════════════════

test("base58 round-trips, and handles the leading-zero case that breaks encoders", () => {
  const core = loadCore();

  // A leading zero byte is encoded as a literal "1" and carries no positional
  // value, so an implementation that treats the buffer as one big integer loses
  // it — and silently yields a 43-character key that is a DIFFERENT address.
  // Real Solana keys hit this: proposal #17 below adds one.
  for (const zeros of [0, 1, 2, 5, 31]) {
    const raw = Buffer.concat([Buffer.alloc(zeros), crypto.randomBytes(32 - zeros)]);
    const encoded = core.b58encode(raw);
    assert.equal(encoded.slice(0, zeros), "1".repeat(zeros), `${zeros} leading zeros lost in encode`);
    assert.deepEqual(Buffer.from(core.b58decode(encoded)), raw, `round trip failed with ${zeros} leading zeros`);
  }

  // The all-zero key is the program's "this slot is EMPTY" sentinel, and it must
  // encode to exactly the 32-character system-program string.
  assert.equal(core.b58encode(new Uint8Array(32)), "11111111111111111111111111111111");
  assert.equal(core.b58encode(new Uint8Array(32)), core.DEFAULT_PUBKEY);

  for (let i = 0; i < 200; i += 1) {
    const raw = crypto.randomBytes(32);
    assert.deepEqual(Buffer.from(core.b58decode(core.b58encode(raw))), raw);
  }
});

test("parsePubkey refuses what is not a 32-byte address", () => {
  const core = loadCore();

  // A typo that reaches an instruction is a key nobody holds. On update_signers
  // that is a vault whose governance is permanently unreachable, so this
  // refusal is load-bearing, not input hygiene.
  assert.equal(core.isValidPubkey(DEVNET_MULTISIG), true);
  assert.equal(core.isValidPubkey("7auwTLSvNniSUeAgL6v9RStMXJhWrrUhSJgwFWLpcqC"), true, "43-char key rejected");

  for (const bad of ["", "0OIl", "notbase58!", "abc", "1".repeat(64)]) {
    assert.equal(core.isValidPubkey(bad), false, `accepted "${bad}" as an address`);
    assert.throws(() => core.parsePubkey(bad, "test"), /test/, `parsePubkey did not name the field for "${bad}"`);
  }

  // Base58 that decodes to the wrong LENGTH is the subtle one: it is valid
  // base58 and looks like an address, so only the length check catches it.
  assert.throws(() => core.parsePubkey(core.b58encode(crypto.randomBytes(31))), /not 32/);
  assert.throws(() => core.parsePubkey(core.b58encode(crypto.randomBytes(33))), /not 32/);
});

// ════════════════════════════════════════════════════════════════════════════
// SHA 256 and the discriminators
// ════════════════════════════════════════════════════════════════════════════

test("sha256 matches node:crypto, including at every padding boundary", () => {
  const core = loadCore();

  // 55/56 and 119/120 are where the length field stops fitting in the current
  // block and a second block is appended. An implementation that gets the
  // padding wrong is correct for short inputs and wrong for a PDA seed set.
  for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 255, 256]) {
    const msg = crypto.randomBytes(n);
    assert.equal(
      toHex(core.sha256(msg)),
      crypto.createHash("sha256").update(msg).digest("hex"),
      `sha256 differs at input length ${n}`
    );
  }
  for (let i = 0; i < 100; i += 1) {
    const msg = crypto.randomBytes(Math.floor(Math.random() * 300));
    assert.equal(toHex(core.sha256(msg)), crypto.createHash("sha256").update(msg).digest("hex"));
  }
});

test("every hardcoded discriminator equals its Anchor definition", () => {
  const core = loadCore();

  // The console writes discriminators out as byte literals so an operator can
  // audit them by eye. That is only safe if something recomputes them from the
  // names — otherwise a transposed digit ships as an instruction the program
  // does not have, and the failure surfaces on chain rather than here.
  const sighash = (namespace, name) =>
    Array.from(crypto.createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8));

  const expected = {
    Multisig: sighash("account", "Multisig"),
    Proposal: sighash("account", "Proposal"),
    ConfigTransaction: sighash("account", "ConfigTransaction"),
    VaultState: sighash("account", "VaultState"),
    GovernanceConfig: sighash("account", "GovernanceConfig"),
    proposalApprove: sighash("global", "proposal_approve"),
    configTransactionExecute: sighash("global", "config_transaction_execute"),
    updateSigners: sighash("global", "update_signers"),
  };

  for (const [name, want] of Object.entries(expected)) {
    assert.deepEqual(core.DISC[name], want, `DISC.${name} does not match sha256("...:${name}")`);
  }
  assert.deepEqual(
    Object.keys(core.DISC).sort(),
    Object.keys(expected).sort(),
    "the console carries a discriminator this test does not check"
  );
});

// ════════════════════════════════════════════════════════════════════════════
// ed25519 and PDA derivation
// ════════════════════════════════════════════════════════════════════════════

test("isOnCurve separates real wallet keys from program-derived addresses", () => {
  const core = loadCore();

  // Every key a human holds IS on the curve — it is a public key with a
  // matching secret. Every PDA is deliberately OFF it, which is precisely what
  // makes a PDA unsignable. An on-curve test stuck on one answer would still
  // "work": findProgramAddress would return a bump, just never the canonical
  // one, and the console would read an account that does not exist.
  const wallets = [
    "BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo",
    "7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr",
    "3Qj4v9qjhXgkru6zCRCErRVhy8Q6qU3NrNpvpXLTZboA",
    "9gACbzsCLmkYF9Yx1EBGmwMvvyfuTquJ6qs8QsoQvHXf",
    "2eGs8G3wzhEeNQQU2Q86BmmA2xTpDbMMae3Y1bvpZfx9",
    "8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd",
  ];
  for (const w of wallets) {
    assert.equal(core.isOnCurve(core.b58decode(w)), true, `${w} should be on the curve`);
  }
  for (const pda of Object.values(GOLDEN_PDA)) {
    assert.equal(core.isOnCurve(core.b58decode(pda)), false, `${pda} is a PDA and must be off the curve`);
  }

  // Both branches must be reachable over random input — roughly half of random
  // 32-byte strings decode to a curve point.
  let on = 0;
  for (let i = 0; i < 200; i += 1) if (core.isOnCurve(crypto.randomBytes(32))) on += 1;
  assert.ok(on > 40 && on < 160, `on-curve rate ${on}/200 is implausible; the test may be stuck on one answer`);
});

test("PDA derivation reproduces the golden addresses", () => {
  const core = loadCore();

  assert.equal(core.vaultStatePda(DEVNET_PROGRAM), GOLDEN_PDA.vaultStateDevnet);
  assert.equal(core.governancePda(DEVNET_PROGRAM), GOLDEN_PDA.governanceDevnet);

  for (const index of [16, 17, 18]) {
    assert.equal(core.squadsProposalPda(DEVNET_MULTISIG, index), GOLDEN_PDA[`proposal${index}`]);
    assert.equal(core.squadsTransactionPda(DEVNET_MULTISIG, index), GOLDEN_PDA[`transaction${index}`]);
  }

  // A different program id must give a different vault PDA. Without this, a
  // derivation that ignored the program id entirely would pass every assertion
  // above, and the console would happily read mainnet's vault while the
  // operator believed they were on devnet.
  assert.notEqual(core.vaultStatePda(MAINNET_PROGRAM), core.vaultStatePda(DEVNET_PROGRAM));

  // And the index must reach the seeds.
  assert.notEqual(core.squadsProposalPda(DEVNET_MULTISIG, 18), core.squadsProposalPda(DEVNET_MULTISIG, 17));
});

// ════════════════════════════════════════════════════════════════════════════
// Decoding real chain accounts
// ════════════════════════════════════════════════════════════════════════════

test("decodeMultisig reads the real devnet multisig, before and after a rotation", () => {
  const core = loadCore();

  const before = core.decodeMultisig(fromB64(FIXTURE.multisigBefore));
  assert.equal(before.threshold, 3);
  assert.equal(before.members.length, 4);
  assert.equal(before.transactionIndex, 18n);
  assert.equal(before.staleTransactionIndex, 16n);
  assert.equal(before.timeLock, 0);
  assert.equal(before.rentCollector, null);

  // An autonomous multisig has configAuthority == default; a CONTROLLED one can
  // have its members changed by a single key with no vote at all, which is a
  // completely different security model. The console renders the distinction,
  // so the decode has to get it right.
  assert.equal(before.configAuthority, core.DEFAULT_PUBKEY);

  assert.deepEqual(
    before.members.map((m) => m.key).sort(),
    [
      "3Qj4v9qjhXgkru6zCRCErRVhy8Q6qU3NrNpvpXLTZboA",
      "7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr",
      "9gACbzsCLmkYF9Yx1EBGmwMvvyfuTquJ6qs8QsoQvHXf",
      "BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo",
    ].sort()
  );
  for (const m of before.members) assert.equal(m.mask, 7);

  const after = core.decodeMultisig(fromB64(FIXTURE.multisigAfter));
  assert.equal(after.threshold, 3);
  assert.equal(after.members.length, 5);
  assert.equal(after.staleTransactionIndex, 18n, "executing a config change must move the stale index");

  // THE TWO SNAPSHOTS MUST TELL THE SAME STORY AS THE PROPOSAL. Decoding each
  // account correctly in isolation is weaker than this: the set difference
  // between them has to be exactly the actions configTransaction18 declares, or
  // one of the three decoders is wrong in a way the individual assertions miss.
  const actions = core.decodeConfigTransaction(fromB64(FIXTURE.configTransaction18)).actions;
  const expected = new Set(before.members.map((m) => m.key));
  for (const a of actions) {
    if (a.kind === "AddMember") expected.add(a.key);
    if (a.kind === "RemoveMember") expected.delete(a.key);
  }
  assert.deepEqual(
    after.members.map((m) => m.key).sort(),
    [...expected].sort(),
    "the before/after difference is not what the proposal said it would do"
  );

  assert.equal(core.describeMask(7), "Initiate + Vote + Execute");
  assert.equal(core.describeMask(2), "Vote");
  assert.equal(core.describeMask(0), "no permissions");
});

test("decodeProposal reads status and the approval set", () => {
  const core = loadCore();

  const p18 = core.decodeProposal(fromB64(FIXTURE.proposal18));
  assert.equal(p18.status, "Active");
  assert.equal(p18.transactionIndex, 18n);
  assert.deepEqual(p18.approved, ["BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo"]);
  assert.deepEqual(p18.rejected, []);
  assert.deepEqual(p18.cancelled, []);
  assert.equal(p18.multisig, DEVNET_MULTISIG);

  const p17 = core.decodeProposal(fromB64(FIXTURE.proposal17));
  assert.equal(p17.status, "Active");
  assert.equal(p17.transactionIndex, 17n);

  // Status is an enum whose variants each wrap a timestamp EXCEPT Executing,
  // which wraps nothing. Reading a timestamp there would consume eight bytes
  // that belong to `bump` and the three vectors after it, and the approval list
  // would come out as garbage — on the screen an operator is using to decide
  // whether the threshold is met.
  assert.equal(core.PROPOSAL_STATUS[4], "Executing");
  assert.equal(core.PROPOSAL_STATUS.length, 7);
});

test("decodeConfigTransaction turns actions into plain words", () => {
  const core = loadCore();

  const t18 = core.decodeConfigTransaction(fromB64(FIXTURE.configTransaction18));
  assert.equal(t18.multisig, DEVNET_MULTISIG);
  assert.equal(t18.declaredActionCount, 3);
  assert.equal(t18.allUnderstood, true);
  assert.deepEqual(
    t18.actions.map((a) => [a.kind, a.key || a.value]),
    [
      ["AddMember", "2eGs8G3wzhEeNQQU2Q86BmmA2xTpDbMMae3Y1bvpZfx9"],
      ["AddMember", "8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd"],
      ["RemoveMember", "9gACbzsCLmkYF9Yx1EBGmwMvvyfuTquJ6qs8QsoQvHXf"],
    ]
  );
  assert.equal(t18.actions[0].verb, "add member");
  assert.equal(t18.actions[2].verb, "remove member");
  assert.equal(t18.actions[0].mask, 7);

  // Six actions of three different kinds in one transaction. Each variant has a
  // different payload width, so this is what proves the walk keeps its place
  // across a mixed list rather than only across repeats of one kind.
  const t16 = core.decodeConfigTransaction(fromB64(FIXTURE.configTransaction16));
  assert.equal(t16.declaredActionCount, 6);
  assert.equal(t16.allUnderstood, true);
  assert.deepEqual(
    t16.actions.map((a) => a.kind),
    ["AddMember", "AddMember", "AddMember", "RemoveMember", "RemoveMember", "ChangeThreshold"]
  );
  assert.equal(t16.actions[5].value, 3, "the trailing ChangeThreshold decoded to the wrong number");

  // The last action is the one a misaligned walk gets wrong, because every
  // earlier error accumulates into it. Asserting it by value is the cheapest
  // check that the whole traversal landed.
  assert.equal(t16.actions[3].key, "8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd");
});

test("decoders refuse an account that is not theirs", () => {
  const core = loadCore();

  // Squads accounts all live under one program and are told apart ONLY by the
  // 8-byte discriminator. Decoding a Proposal as a ConfigTransaction yields
  // plausible-looking pubkeys rather than an error, so the guard has to be the
  // discriminator and it has to bite.
  assert.throws(() => core.decodeConfigTransaction(fromB64(FIXTURE.proposal18)), /not a Squads ConfigTransaction/);
  assert.throws(() => core.decodeProposal(fromB64(FIXTURE.configTransaction18)), /not a Squads Proposal/);
  assert.throws(() => core.decodeMultisig(fromB64(FIXTURE.proposal18)), /not a Squads Multisig/);
  assert.throws(() => core.decodeMultisig(new Uint8Array(4)), /not a Squads Multisig/);
});

test("an action this console cannot name is surfaced, never skipped", () => {
  const core = loadCore();

  // AddSpendingLimit (variant 4) carries two nested vectors this decoder does
  // not walk, so after meeting one the read position is meaningless. Dropping
  // it from the list would make the proposal look SMALLER than it is — the
  // operator would approve four actions having been shown three. So the walk
  // stops, marks itself, and the UI withholds execute.
  const header = fromB64(FIXTURE.configTransaction18).subarray(0, 8 + 32 + 32 + 8 + 1);
  const forged = core.concatBytes([
    header,
    Uint8Array.from([2, 0, 0, 0]), // two actions declared
    Uint8Array.from([1]), core.parsePubkey("9gACbzsCLmkYF9Yx1EBGmwMvvyfuTquJ6qs8QsoQvHXf"), // RemoveMember
    Uint8Array.from([4]), new Uint8Array(64), // AddSpendingLimit — undecoded
  ]);

  const decoded = core.decodeConfigTransaction(forged);
  assert.equal(decoded.declaredActionCount, 2);
  assert.equal(decoded.allUnderstood, false, "an undecoded action was waved through");
  assert.equal(decoded.truncated, true);
  assert.equal(decoded.actions[0].kind, "RemoveMember");
  assert.equal(decoded.actions[1].understood, false);
  assert.match(decoded.actions[1].verb, /UNDECODED/);

  // The control: the same walk over a list with no unknown variant must report
  // allUnderstood, or the flag above would be meaningless.
  assert.equal(core.decodeConfigTransaction(fromB64(FIXTURE.configTransaction18)).allUnderstood, true);
});

// ════════════════════════════════════════════════════════════════════════════
// Instruction building and message serialization
// ════════════════════════════════════════════════════════════════════════════

test("Squads instructions match the SDK's bytes and account order", () => {
  const core = loadCore();
  const member = GOLDEN_PAYER;

  const approve = core.ixProposalApprove(DEVNET_MULTISIG, member, GOLDEN_PDA.proposal18);
  assert.equal(approve.programId, SQUADS_PROGRAM);
  // 8-byte discriminator + ProposalVoteArgs { memo: Option<String> } = None.
  assert.equal(toHex(approve.data), "9025a488bcd82af800");
  assert.deepEqual(
    approve.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable]),
    [
      [DEVNET_MULTISIG, false, false],
      [member, true, true],
      [GOLDEN_PDA.proposal18, false, true],
    ]
  );

  const execute = core.ixConfigTransactionExecute(
    DEVNET_MULTISIG, member, GOLDEN_PDA.proposal18, GOLDEN_PDA.transaction18, member
  );
  assert.equal(toHex(execute.data), "7292f4bdfc8c2428");
  assert.deepEqual(
    execute.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable]),
    [
      [DEVNET_MULTISIG, false, true],
      [member, true, false],
      [GOLDEN_PDA.proposal18, false, true],
      [GOLDEN_PDA.transaction18, false, false],
      // rentPayer is a real signer: AddMember grows the Multisig account and the
      // realloc is funded from here. Passing the program id instead (the SDK's
      // "None" encoding) makes any membership change fail on chain.
      [member, true, true],
      [core.SYSTEM_PROGRAM_ID, false, false],
    ]
  );
});

test("compileMessage reproduces web3.js byte for byte", () => {
  const core = loadCore();
  const member = GOLDEN_PAYER;
  const approve = core.ixProposalApprove(DEVNET_MULTISIG, member, GOLDEN_PDA.proposal18);
  const execute = core.ixConfigTransactionExecute(
    DEVNET_MULTISIG, member, GOLDEN_PDA.proposal18, GOLDEN_PDA.transaction18, member
  );

  const cases = { approve: [approve], execute: [execute], both: [approve, execute] };
  for (const [name, instructions] of Object.entries(cases)) {
    const compiled = core.compileMessage({
      payer: member, instructions, recentBlockhash: GOLDEN_BLOCKHASH,
    });
    assert.equal(toHex(compiled.message), GOLDEN_MESSAGE[name], `${name}: message bytes differ from web3.js`);
    assert.deepEqual(compiled.signerKeys, [member], `${name}: signer list differs`);
  }
});

test("assembleTransaction leaves a zero slot for a signature it does not hold", () => {
  const core = loadCore();
  const message = bytes(GOLDEN_MESSAGE.approve);
  const signers = [GOLDEN_PAYER, "7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr"];

  // An unsigned slot is 64 zero bytes. That is what makes a partly signed
  // transaction carryable between wallets, and what lets an unsigned copy be
  // handed to simulateTransaction with sigVerify off.
  const unsigned = core.assembleTransaction(message, signers, {});
  assert.equal(unsigned.length, 1 + 64 * 2 + message.length);
  assert.equal(unsigned[0], 2, "shortvec signature count is wrong");
  assert.deepEqual(Array.from(unsigned.subarray(1, 129)), new Array(128).fill(0));

  const sig = crypto.randomBytes(64);
  const partial = core.assembleTransaction(message, signers, { [GOLDEN_PAYER]: sig });
  assert.deepEqual(Buffer.from(partial.subarray(1, 65)), sig, "the held signature landed in the wrong slot");
  assert.deepEqual(Array.from(partial.subarray(65, 129)), new Array(64).fill(0), "the absent signer's slot is not zero");
});

// ════════════════════════════════════════════════════════════════════════════
// Turf Vault: layout, structural detection, update_signers
// ════════════════════════════════════════════════════════════════════════════

test("the console's VaultState layout agrees with scripts/lib/vault-layout.js", () => {
  const core = loadCore();
  const layout = require(path.join(SCRIPTS_DIR, "lib", "vault-layout.js"));

  // VaultState is zero_copy + repr(C): every field's OFFSET is its identity,
  // and nothing on chain says so. vault-layout.js is already checked against the
  // Rust struct itself by scripts/tests/vault-layout.test.js, so agreeing with
  // it chains this console to the program's real layout rather than to a second
  // hand copy of the numbers.
  assert.equal(core.VAULT.ACCOUNT_LEN, layout.ACCOUNT_LEN);
  assert.equal(core.VAULT.DATA_LEN, layout.DATA_LEN);
  assert.equal(core.VAULT.MAX_SIGNERS, layout.MAX_SIGNERS);
  assert.equal(core.VAULT.BASE_SLOTS, layout.BASE_SLOTS);
  assert.equal(core.VAULT.EXT_SLOTS, layout.EXT_SLOTS);
  assert.equal(core.DEFAULT_PUBKEY, layout.DEFAULT_PUBKEY);
  for (const field of ["signers", "threshold", "bump", "paused", "payout_mint", "treasury_authority", "signers_ext"]) {
    assert.equal(core.VAULT.OFFSETS[field], layout.OFFSETS[field], `offset of ${field} disagrees`);
  }
});

test("readSignerSlots reads all five slots and refuses a short buffer", () => {
  const core = loadCore();
  const layout = require(path.join(SCRIPTS_DIR, "lib", "vault-layout.js"));

  const keys = [
    "8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd",
    "7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr",
    "CytJS23p1zCM2wvUUngiDePtbMB484ebD7bK4nDqWjrR",
  ];
  const data = new Uint8Array(core.VAULT.ACCOUNT_LEN);
  data.set(core.DISC.VaultState, 0);
  keys.forEach((k, i) => data.set(core.parsePubkey(k), 8 + core.VAULT.OFFSETS.signers + i * 32));

  const slots = core.readSignerSlots(data);
  assert.equal(slots.length, 5);
  assert.deepEqual(slots.slice(0, 3).map((s) => s.key), keys);
  assert.deepEqual(slots.slice(0, 3).map((s) => s.field), ["signers", "signers", "signers"]);
  assert.deepEqual(slots.slice(3).map((s) => s.empty), [true, true]);
  assert.deepEqual(slots.slice(3).map((s) => s.field), ["signers_ext", "signers_ext"]);

  // The same buffer through the already-proven reader must give the same answer.
  const viaLayout = layout.readSignerSlots(Buffer.from(data), (b) => core.b58encode(b));
  assert.deepEqual(slots.map((s) => s.key), viaLayout.map((s) => s.base58));

  // A short buffer must be refused rather than decoded, because at these
  // offsets a truncated account reads as a set of real-looking keys.
  assert.throws(() => core.readSignerSlots(new Uint8Array(200)), /Refusing to decode/);
  assert.throws(() => core.readSignerSlots(null), /Refusing to decode/);

  // Left-packing: the program refuses a live key after an empty slot.
  assert.equal(core.isLeftPacked(slots), true);
  const gapped = core.readSignerSlots((() => {
    const d = new Uint8Array(core.VAULT.ACCOUNT_LEN);
    d.set(core.DISC.VaultState, 0);
    d.set(core.parsePubkey(keys[0]), 8 + core.VAULT.OFFSETS.signers);
    d.set(core.parsePubkey(keys[1]), 8 + core.VAULT.OFFSETS.signers_ext);
    return d;
  })());
  assert.equal(core.isLeftPacked(gapped), false, "a gap was not detected");
});

test("the program shape is detected structurally, never from a version string", () => {
  const core = loadCore();

  // Written when turf-vault shipped BOTH programs reporting metadata.version
  // 0.25.0: a version check then returned a plausible answer and picked the
  // WRONG shape. The crate was bumped to 0.26.0 on 2026-09-15 and a guard now
  // keeps it ahead of the last release (scripts/tests/crate-version.test.js,
  // /tasks/cargo-version-lies-about-program) — and this probe still does not
  // read it. A version is a DECLARATION: it is true only because someone wrote
  // it down, and the cost of it being wrong is silent, because Anchor account
  // lists are positional. So the probe asks the chain for the account that
  // actually differs: GovernanceConfig exists only under the five-slot
  // program, and the five-slot update_signers cannot be built without it.
  const absent = core.detectVaultShape(null);
  assert.equal(absent.slots, 3);
  assert.equal(absent.hasGovernance, false);

  const good = new Uint8Array(120);
  good.set(core.DISC.GovernanceConfig, 0);
  const present = core.detectVaultShape({ data: good });
  assert.equal(present.slots, 5);
  assert.equal(present.hasGovernance, true);

  // An account sitting at the governance address that is NOT a GovernanceConfig
  // is an anomaly, not a five-slot vault. Trusting mere presence would build the
  // five-slot instruction against a program that has no such account.
  const foreign = new Uint8Array(120);
  foreign.set(core.DISC.Multisig, 0);
  const odd = core.detectVaultShape({ data: foreign });
  assert.equal(odd.slots, 3);
  assert.equal(odd.anomaly, true);
});

test("update_signers is built for whichever shape the probe reported", () => {
  const core = loadCore();
  const vaultState = GOLDEN_PDA.vaultStateDevnet;
  const governance = GOLDEN_PDA.governanceDevnet;
  const newSigners = [
    "8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd",
    "7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr",
    "CytJS23p1zCM2wvUUngiDePtbMB484ebD7bK4nDqWjrR",
  ];
  const signers = [
    GOLDEN_PAYER,
    "7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr",
    "3Qj4v9qjhXgkru6zCRCErRVhy8Q6qU3NrNpvpXLTZboA",
  ];

  // THREE-SLOT (the deployed program): admin, cosigner, vault_state. Args are
  // [Pubkey; 3] => 8 + 96 bytes. No governance account exists to pass.
  const three = core.ixUpdateSigners({
    programId: DEVNET_PROGRAM,
    shape: { slots: 3, hasGovernance: false },
    vaultState, governance, newSigners, signers: signers.slice(0, 2),
  });
  assert.equal(three.data.length, 8 + 96);
  assert.equal(toHex(three.data.subarray(0, 8)), toHex(Uint8Array.from(core.DISC.updateSigners)));
  assert.deepEqual(
    three.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable]),
    [[signers[0], true, true], [signers[1], true, false], [vaultState, false, true]]
  );

  // FIVE-SLOT: governance is appended, and extra cosigners ride as leading
  // remaining accounts. This is the wire shape instructions::governance::authorize
  // reads, and it is what scripts/rotate-devnet-signers.js already sends.
  const five = core.ixUpdateSigners({
    programId: DEVNET_PROGRAM,
    shape: { slots: 5, hasGovernance: true },
    vaultState, governance, newSigners, signers,
  });
  assert.equal(five.data.length, 8 + 160, "five-slot args must be [Pubkey; 5]");
  assert.deepEqual(
    five.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable]),
    [
      [signers[0], true, true],
      [signers[1], true, false],
      [vaultState, false, true],
      [governance, false, false],
      [signers[2], true, false],
    ]
  );

  // Unfilled slots are the all-zero sentinel, and they are a SUFFIX. The tail of
  // the five-slot payload must be 64 zero bytes given three keys.
  assert.deepEqual(Array.from(five.data.subarray(8 + 96)), new Array(64).fill(0));

  // More keys than the program has slots is a refusal, not a silent truncation:
  // dropping the fifth key would rotate to a set the operator never approved.
  assert.throws(
    () => core.ixUpdateSigners({
      programId: DEVNET_PROGRAM,
      shape: { slots: 3, hasGovernance: false },
      vaultState, governance, signers: signers.slice(0, 2),
      newSigners: newSigners.concat(["9gACbzsCLmkYF9Yx1EBGmwMvvyfuTquJ6qs8QsoQvHXf"]),
    }),
    /3 signer slots/
  );
});

// ════════════════════════════════════════════════════════════════════════════
// The refusal
// ════════════════════════════════════════════════════════════════════════════

test("planDigest moves when the on-chain subject moves", () => {
  const core = loadCore();

  // "Refuses to send anything it has not displayed" is only a mechanism if the
  // digest actually changes. What is folded in deliberately includes the
  // SUBJECT — the approvals, the threshold, the membership, the decoded actions
  // — not just the instruction bytes, because a proposal that gained an
  // approval or a multisig whose threshold moved changes what pressing
  // "execute" MEANS while the bytes stay identical.
  const base = {
    kind: "execute",
    cluster: "devnet",
    rpc: "https://api.devnet.solana.com",
    payer: GOLDEN_PAYER,
    instructions: [core.ixConfigTransactionExecute(
      DEVNET_MULTISIG, GOLDEN_PAYER, GOLDEN_PDA.proposal18, GOLDEN_PDA.transaction18, GOLDEN_PAYER
    )],
    subject: {
      multisig: DEVNET_MULTISIG,
      index: 18,
      proposalStatus: "Active",
      approvals: [GOLDEN_PAYER],
      threshold: 3,
      members: ["a:7", "b:7", "c:7", "d:7"],
      actions: ["AddMember|2eGs8G3wzhEeNQQU2Q86BmmA2xTpDbMMae3Y1bvpZfx9||7"],
    },
  };
  // Clone everything EXCEPT the instructions, whose `data` is a Uint8Array that
  // a JSON round trip would turn into a plain object.
  const clone = () => Object.assign({}, base, {
    subject: JSON.parse(JSON.stringify(base.subject)),
    instructions: base.instructions,
  });

  const digest = core.planDigest(base);
  assert.match(digest, /^[0-9a-f]{32}$/);
  assert.equal(core.planDigest(clone()), digest, "the digest is not stable across equal inputs");

  const mutate = (fn) => {
    const copy = clone();
    fn(copy);
    return core.planDigest(copy);
  };

  // Each of these is a real way the meaning changes under the operator's feet.
  assert.notEqual(mutate((p) => { p.subject.approvals.push("someone-else"); }), digest, "a new approval did not move the digest");
  assert.notEqual(mutate((p) => { p.subject.threshold = 2; }), digest, "a threshold change did not move the digest");
  assert.notEqual(mutate((p) => { p.subject.members.push("e:7"); }), digest, "a membership change did not move the digest");
  assert.notEqual(mutate((p) => { p.subject.actions[0] = "AddMember|someone-else||7"; }), digest, "a changed action did not move the digest");
  assert.notEqual(mutate((p) => { p.subject.proposalStatus = "Approved"; }), digest, "a status change did not move the digest");
  assert.notEqual(mutate((p) => { p.cluster = "mainnet-beta"; }), digest, "a cluster change did not move the digest");
  assert.notEqual(mutate((p) => { p.kind = "approve"; }), digest, "the action kind did not move the digest");

  // And the instruction bytes themselves.
  const otherIx = core.ixProposalApprove(DEVNET_MULTISIG, GOLDEN_PAYER, GOLDEN_PDA.proposal18);
  assert.notEqual(
    core.planDigest(Object.assign({}, base, { instructions: [otherIx] })),
    digest,
    "different instruction bytes did not move the digest"
  );

  // THE DISARM CASE, found by this suite on 2026-09-15. `hex()` used to walk
  // `bytes.length` without checking it, so instruction data that was not a byte
  // array (a JSON round trip turns a Uint8Array into a plain object) rendered as
  // the empty string. Two different instructions then produced the SAME digest,
  // and the re-verify before sending would have compared equal while the
  // transaction differed — the one mechanism standing between the operator and
  // an unshown transaction, silently disarmed. It must refuse instead.
  const notBytes = { 0: 144, 1: 37, 2: 164 };
  assert.throws(() => core.hex(notBytes), /expected a byte array/);
  assert.throws(() => core.hex(null), /expected a byte array/);
  assert.throws(() => core.hex([1, 2, 999]), /not a byte/);
  assert.throws(
    () => core.planDigest(Object.assign({}, base, {
      instructions: [Object.assign({}, base.instructions[0], { data: notBytes })],
    })),
    /expected a byte array/,
    "planDigest folded a non-byte-array payload instead of refusing"
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Optional: cross-check against the reference implementation when it is present
// ════════════════════════════════════════════════════════════════════════════

test("cross-check against @solana/web3.js when the dependency tree is installed", (t) => {
  let web3;
  try {
    web3 = require(require.resolve("@solana/web3.js", { paths: [SCRIPTS_DIR] }));
  } catch (_e) {
    t.skip("runtime deps not installed (CI guards lane installs nothing)");
    return;
  }
  const core = loadCore();
  const { PublicKey, Transaction, TransactionInstruction, Keypair } = web3;

  // The golden vectors above were frozen from this implementation. Where it IS
  // available, re-derive them live so the vectors cannot quietly rot against a
  // web3.js that changed its account-ordering rules.
  for (const [seedName, seeds, programId, want] of [
    ["vault", [Buffer.from("vault")], DEVNET_PROGRAM, GOLDEN_PDA.vaultStateDevnet],
    ["governance", [Buffer.from("governance")], DEVNET_PROGRAM, GOLDEN_PDA.governanceDevnet],
  ]) {
    const [ref] = PublicKey.findProgramAddressSync(seeds, new PublicKey(programId));
    assert.equal(ref.toBase58(), want, `${seedName}: the golden PDA no longer matches web3.js`);
  }

  // Random transactions, not just the hand-picked ones: this is what exercises
  // the account-ordering rules rather than the five shapes we happened to think of.
  for (let trial = 0; trial < 120; trial += 1) {
    const pool = Array.from({ length: 2 + Math.floor(Math.random() * 6) }, () => Keypair.generate().publicKey.toBase58());
    const programs = Array.from({ length: 1 + Math.floor(Math.random() * 2) }, () => Keypair.generate().publicKey.toBase58());
    const payer = pool[0];
    const instructions = [];
    for (let i = 0; i < 1 + Math.floor(Math.random() * 3); i += 1) {
      const keys = [];
      for (let k = 0; k < Math.floor(Math.random() * pool.length); k += 1) {
        keys.push({
          pubkey: pool[Math.floor(Math.random() * pool.length)],
          isSigner: Math.random() < 0.4,
          isWritable: Math.random() < 0.5,
        });
      }
      instructions.push({
        programId: programs[Math.floor(Math.random() * programs.length)],
        keys,
        data: Uint8Array.from(crypto.randomBytes(Math.floor(Math.random() * 40))),
      });
    }

    const mine = core.compileMessage({ payer, instructions, recentBlockhash: GOLDEN_BLOCKHASH });
    const tx = new Transaction();
    tx.feePayer = new PublicKey(payer);
    tx.recentBlockhash = GOLDEN_BLOCKHASH;
    for (const ix of instructions) {
      tx.add(new TransactionInstruction({
        programId: new PublicKey(ix.programId),
        keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
        data: Buffer.from(ix.data),
      }));
    }
    let reference;
    try { reference = tx.serializeMessage(); } catch (_e) { continue; }
    assert.equal(toHex(mine.message), reference.toString("hex"), `trial ${trial}: message bytes differ from web3.js`);
  }

  // And the on-curve test, which is the one piece of field arithmetic here.
  for (let i = 0; i < 150; i += 1) {
    const raw = crypto.randomBytes(32);
    assert.equal(core.isOnCurve(raw), PublicKey.isOnCurve(raw), `isOnCurve differs on ${raw.toString("hex")}`);
  }
});
