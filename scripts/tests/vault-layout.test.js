"use strict";

/**
 * Guard: scripts/lib/vault-layout.js agrees with the Rust struct it describes.
 *
 * ── WHY THIS TEST EXISTS ──────────────────────────────────────────────────
 *
 * `VaultState` is an Anchor `zero_copy(unsafe)` + `#[repr(C)]` account. There
 * is no name-keyed decode and no version tag: a field IS its byte offset. The
 * ceremony scripts in this directory read those bytes directly rather than
 * through the IDL, because an operator running them on the worst day may have
 * no build and no toolchain — which means the offsets are declared in TWO
 * places, `state.rs` and `lib/vault-layout.js`.
 *
 * Two declarations of the same physical fact is exactly the setup where one
 * quietly moves. A script reading a stale offset does not crash; it prints a
 * confident, wrong answer — "slots 4 and 5 are empty, safe to rotate" read out
 * of the middle of the currency registry. So the coupling is ENFORCED rather
 * than assumed: this test PARSES the Rust struct and recomputes every offset
 * from the declared field widths.
 *
 * Pure `node:test` + `node:fs`, so it runs in CI's `guards` lane with no
 * dependency tree and no chain access.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const layout = require("../lib/vault-layout.js");

const STATE_RS = path.join(__dirname, "..", "..", "programs", "turf_vault", "src", "state.rs");

/** Widths of the types that appear in VaultState, in bytes. */
const WIDTH = {
  "Pubkey": 32,
  "u8": 1,
  "[Pubkey; 3]": 96,
  "[Pubkey; 2]": 64,
  "[AcceptedCurrency; 16]": 1280,
  "[u8; 0]": 0,
  "[u8; 64]": 64,
};

/** Parse `pub struct VaultState { … }` into ordered {name, type} entries. */
function parseVaultState() {
  const src = fs.readFileSync(STATE_RS, "utf8");
  const start = src.indexOf("pub struct VaultState {");
  assert.ok(start !== -1, "could not find `pub struct VaultState` in state.rs");
  const end = src.indexOf("\n}", start);
  assert.ok(end !== -1, "could not find the end of the VaultState struct");
  const body = src.slice(start, end);

  const fields = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("///") || line.startsWith("//") || !line.startsWith("pub ")) continue;
    const m = line.match(/^pub\s+(\w+):\s*(.+?),\s*(?:\/\/.*)?$/);
    if (!m) continue;
    fields.push({ name: m[1], type: m[2].trim() });
  }
  return fields;
}

test("every VaultState field is a type this guard knows how to measure", () => {
  for (const f of parseVaultState()) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(WIDTH, f.type),
      `VaultState.${f.name} has type \`${f.type}\`, which this guard cannot size. ` +
        "Add its width to WIDTH — do not delete the assertion: an unmeasured field " +
        "is an offset nobody is checking."
    );
  }
});

test("the JS offsets match the offsets implied by the Rust field order", () => {
  const fields = parseVaultState();
  let offset = 0;
  const computed = {};
  for (const f of fields) {
    computed[f.name] = offset;
    offset += WIDTH[f.type];
  }

  for (const [name, declared] of Object.entries(layout.OFFSETS)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(computed, name),
      `vault-layout.js declares an offset for \`${name}\`, which VaultState does not have`
    );
    assert.strictEqual(
      declared,
      computed[name],
      `OFFSET MISMATCH for \`${name}\`: vault-layout.js says ${declared}, ` +
        `state.rs field order puts it at ${computed[name]}. ` +
        "DO NOT just update the JS number — first work out whether a field was " +
        "INSERTED or WIDENED, which would misread every vault already on chain."
    );
  }

  assert.strictEqual(
    offset,
    layout.DATA_LEN,
    `VaultState is ${offset} data bytes by field widths, but vault-layout.js says ${layout.DATA_LEN}`
  );
  assert.strictEqual(layout.ACCOUNT_LEN, 8 + layout.DATA_LEN);
});

test("the signer slots are 3 + 2 and the reserve is exhausted", () => {
  const fields = parseVaultState();
  const byName = Object.fromEntries(fields.map((f) => [f.name, f.type]));

  assert.strictEqual(byName.signers, "[Pubkey; 3]", "signers must stay 3 wide — widening it in place shifts every field after it");
  assert.strictEqual(byName.signers_ext, "[Pubkey; 2]");
  assert.strictEqual(
    byName._reserved,
    "[u8; 0]",
    "the reserve is fully consumed by signers_ext; a new field needs its own PDA"
  );
  assert.strictEqual(layout.MAX_SIGNERS, 5);
  assert.strictEqual(layout.BASE_SLOTS + layout.EXT_SLOTS, layout.MAX_SIGNERS);
});

test("signers_ext begins exactly where the old _reserved began", () => {
  // THE MIGRATION PREMISE, stated as an assertion. The two new slots were
  // carved out of the 64 reserved bytes at the tail — verified all-zero on
  // devnet and mainnet before the claim — so a vault that has never been
  // rotated reads them as the empty sentinel and behaves exactly as it did
  // before the upgrade. 1507 - 64 = 1443.
  assert.strictEqual(layout.OFFSETS.signers_ext, layout.DATA_LEN - 64);
  assert.strictEqual(layout.EXT_SLOTS * layout.PUBKEY, 64);
});

test("readSignerSlots refuses a short buffer instead of decoding garbage", () => {
  const short = Buffer.alloc(100);
  assert.throws(
    () => layout.readSignerSlots(short, () => "x"),
    /expected 1515/,
    "a short account must be refused — at these offsets a short read is silent nonsense"
  );
});

test("readSignerSlots reports empty slots as empty, and keeps slot identity", () => {
  const data = Buffer.alloc(layout.ACCOUNT_LEN);
  // Three occupied slots, two empty — the shape every live vault is in today.
  data[8 + layout.OFFSETS.signers + 0] = 1;
  data[8 + layout.OFFSETS.signers + 32] = 2;
  data[8 + layout.OFFSETS.signers + 64] = 3;

  const encode = (b) => (b.every((x) => x === 0) ? layout.DEFAULT_PUBKEY : "key" + b[0]);
  const slots = layout.readSignerSlots(data, encode);

  assert.strictEqual(slots.length, 5);
  assert.deepStrictEqual(
    slots.map((s) => s.empty),
    [false, false, false, true, true]
  );
  assert.deepStrictEqual(
    slots.map((s) => s.field),
    ["signers", "signers", "signers", "signers_ext", "signers_ext"]
  );
  assert.strictEqual(layout.isUnrotated(slots), true);
  assert.strictEqual(layout.isLeftPacked(slots), true);
});

test("a rotated five-slot set reads as rotated, and a gap reads as not packed", () => {
  const encode = (b) => (b.every((x) => x === 0) ? layout.DEFAULT_PUBKEY : "key" + b[0]);

  const full = Buffer.alloc(layout.ACCOUNT_LEN);
  for (let i = 0; i < 3; i += 1) full[8 + layout.OFFSETS.signers + i * 32] = i + 1;
  for (let i = 0; i < 2; i += 1) full[8 + layout.OFFSETS.signers_ext + i * 32] = i + 4;
  const rotated = layout.readSignerSlots(full, encode);
  assert.strictEqual(layout.isUnrotated(rotated), false);
  assert.strictEqual(layout.isLeftPacked(rotated), true);

  // A live key in signers_ext with slot 2 empty — the shape update_signers
  // refuses to WRITE, so observing it means something is wrong.
  const gapped = Buffer.alloc(layout.ACCOUNT_LEN);
  gapped[8 + layout.OFFSETS.signers + 0] = 1;
  gapped[8 + layout.OFFSETS.signers + 32] = 2;
  gapped[8 + layout.OFFSETS.signers_ext + 0] = 4;
  assert.strictEqual(layout.isLeftPacked(layout.readSignerSlots(gapped, encode)), false);
});
