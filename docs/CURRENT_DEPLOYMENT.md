# Current Deployment

This is the live operator reference for TurfVault deployment identity. Keep historical launch and rotation plans separate from this file.

## Devnet

| Field | Value |
|-------|-------|
| Program ID | `EQGFJAcABtDb6VXtiijTjZ6cE2UqdvhnqJvoharJbpMJ` |
| Version | v0.25.0 |
| Deployed | 2026-06-11, slot `468716417` |
| Upgrade authority | Squads V4 vault PDA `BW13kgfiG2koFn3WRkte21NW9TFygsD1ge2fNJdjH6kC` |
| `VaultState` threshold | 2-of-3 for treasury and governance ops — the program's own signer set below, NOT the Squads multisig that holds the upgrade authority (3-of-5; see **Squads Governance**) |
| Alex Bot signer | `8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd` |
| Alex signer | `7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr` |
| Mason signer | `CytJS23p1zCM2wvUUngiDePtbMB484ebD7bK4nDqWjrR` |
| Program SHA256 | `a0611d29b8ddb001e0c5e1b87425745f079b965e1ed1fb87b1990170cd5f5341` (544,632 bytes) |

The old devnet program `Dx8uGU5w7B9NytDSsW4kseGZuqdVVRq1KY1mGXN2GaCT` is orphaned. Do not use it for live verification. **Orphaned is not closed.** Read at `finalized` on 2026-09-16, it is still upgradeable by the same Squads vault `BW13kgfi…` (last deployed 2026-05-25, slot `464879124`), and its old-layout `VaultState` still lists the retired `F6f8...KzhZ` as a signer beside `7ZDJp7FU…` and `CytJS23p…`. It holds only the devnet test mint.

The retired Alex Bot signer `F6f8...KzhZ` left the live devnet program in two separate transactions, one per authority. Both were decoded from chain on 2026-09-16:

| Authority | `F6f8...KzhZ` removed | Evidence |
|-----------|-----------------------|----------|
| `VaultState` signer set of `EQGFJAcA…` | 2026-06-02 18:29:51Z | `update_signers`, slot `466694441`, cosigned by `7ZDJp7FU…` and `CytJS23p…`; replaced by `8K81w4e6…` |
| devnet Squads membership (`7nRuVw3V…`) | 2026-06-06 22:00:14Z | Squads config transaction #11: `RemoveMember F6f8…`, `AddMember 8K81w4e6…` |

So "retired 2026-06-02" and "retired 2026-06-06" are both true, of different authorities. Name the authority when you cite a date. The key keeps its slot in the orphaned `Dx8u…` vault above. Agent key material should be referenced through 1Password item names, not pasted into docs.

## Mainnet

| Field | Value |
|-------|-------|
| Program ID | `DaFv83yokwTz8msP9CzJ13eazSGk15NuUTxjkfzJzxMM` |
| Version | v0.25.0 |
| Deployed | 2026-06-11, slot `425788802` |
| Upgrade authority | Squads V4 vault PDA `Bk9sS7iiSRL18vuo2KVzkeGw7EekKqxMCjrdoyGGdJm` |
| `VaultState` threshold | 2-of-3 for treasury and governance ops — the program's own signer set below, NOT the Squads multisig that holds the upgrade authority (3-of-5; see **Squads Governance**) |
| Alex Bot signer | `8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd` |
| Alex signer | `7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr` |
| Mason signer | `CytJS23p1zCM2wvUUngiDePtbMB484ebD7bK4nDqWjrR` |
| Expected IDL hash | `b9b522635894a42f5434f1faa1cd126d146f3042ae2c233acd1dd76a300f7152` |
| Program SHA256 | `e71a3fce25f8b5f28a203b33705a0274ebf1b2200c9f092ac86339931f2dbee7` (545,928 bytes) |
| Consumer app | `turf-monster-mainnet` |

**The FIRST mainnet deployment is still on chain, and the retired key still holds authority in it.** `MAINNET_LAUNCH.md` was executed against a program that is not the one above. Squads multisig `9dCLMZct…` was created on 2026-05-26 at 2-of-3 with `7ZDJp7FU…`, `F6f8...KzhZ` and `CytJS23p…`. Program `mnzowM2F…` was deployed from `F6f8...KzhZ` at 2026-06-02 08:56:16Z, and its authority passed to that Squad's vault `83BXrVFB…` 19 seconds later. The Alex Bot leak then forced the `KEY_ROTATION.md` redeploy onto `DaFv83yo…` later that day. Read at `finalized` on 2026-09-16, the old deployment was never retired:

- `9dCLMZct…` still reads **2-of-3** with `F6f8...KzhZ` seated, and has never had a transaction.
- `mnzowM2F…` is still open and upgradeable by `83BXrVFB…`; its ProgramData still holds 3.50 SOL of rent.
- Its `VaultState` still lists `F6f8...KzhZ`, `7ZDJp7FU…` and `CytJS23p…` at threshold 2.
- It holds 0 USDC and 0 USDT, and `turf-monster-mainnet`'s `SOLANA_PROGRAM_ID` is `DaFv83yo…`, not it.

`KEY_ROTATION.md` §7 (evict the key from `9dCLM…`) and §8 (close `mnzow…`) are the two steps that retire it, and neither has run. So "`F6f8` holds no mainnet authority" is true of the LIVE program and its Squad only.

Both clusters run **v0.25.0** today; mainnet reached it on 2026-06-11, nine minutes after devnet. The next upgrade window carries `burn_entry_token` AND the v0.26 governance change (both Unreleased in `CHANGELOG.md`), which change the IDL and so need a freshly built `EXPECTED_IDL_HASH` pinned on `turf-monster-mainnet`. The Version row above is read off the deployed executable, not inferred from a commit message; the method is under **Verification** below.

**The crate version is not this row.** `programs/turf_vault/Cargo.toml` reads `0.26.0` as of 2026-09-15: that is what the SOURCE is, and it is the label a freshly built IDL will carry. Both tables above say v0.25.0 because that is what the CHAIN runs. The two agree again only after the upgrade window. Reading `0.26.0` in the crate and concluding these rows are stale is the mistake this paragraph exists to prevent.

**The `VaultState` threshold rows above describe v0.25, which is what is DEPLOYED.** They say
2-of-3 because that is what the deployed program can express: `validate_multisig`
takes exactly two signers and never reads the `threshold` field at all. v0.26
replaces that with per-action thresholds stored in a `GovernanceConfig` PDA
(3 for anything that moves money or changes who governs, 2 for pause, 3 for
unpause), and widens the signer set to five slots. **None of that is live yet** —
do not read the new table in `CHANGELOG.md` as a description of the chain.

When v0.26 does land, two rows here need re-deriving and one step must not be
skipped: `init_governance` has to run immediately after the upgrade, because
every vault-authorized instruction requires the account it creates. See
`RUNBOOK.md` → *v0.26 Upgrade Ordering*. The signer rows do NOT change at
deploy — the two appended slots read as empty until a human runs the ceremony in
`SIGNER_ROTATION.md`. `node scripts/check-signer-slots.js` reads all five slots
off either cluster and is the cheapest way to re-derive the signer rows above;
run on 2026-09-15 it reported 1515-byte accounts and the same three signers on
both clusters, with slots 4 and 5 empty.

**The upgrade authority is per cluster.** Mainnet's Squads vault PDA (`Bk9sS7ii...`) is a different vault from devnet's (`BW13kgfi...`). Never carry one cluster's vault address to the other; the devnet address is the one that historically leaked into mainnet-facing prose. The `VaultState` signer set and threshold are identical on both clusters today, but nothing in the program ties them together — each cluster's `VaultState` was written by its own `initialize`, and `update_signers` can move one without the other. Read the cluster you mean.

Do not infer the live mainnet version from Turf Monster's committed IDL file alone. The source tree can carry a next-upgrade IDL before the Heroku app has accepted it, so that file can describe a program which is not yet on chain. Until 2026-09-15 there was a second and worse way to be misled: an unreleased tree could keep the released crate version, so a freshly built IDL's `metadata.version` read identically to the live one and no comparison could separate them. `scripts/tests/crate-version.test.js` now refuses that tree. Treat the version as a label for humans even so — it is a DECLARATION rather than a measurement, true only because someone wrote it down, so never branch on it. Live truth is the chain: the instruction-set probe under **Verification** below, cross-checked against the `EXPECTED_IDL_HASH` configured on `turf-monster-mainnet`. This note records that reading; it does not replace it. Its mainnet rows once sat nearly three months stale while claiming to have been verified.

## Verification

Every row of both tables above was re-derived on **2026-09-07** with the
commands below — from chain, except the two consumer-side rows. `Expected IDL
hash` comes from `turf-monster`'s Heroku config and the committed IDL file it
must equal; `Consumer app` names that Heroku app. Chain cannot supply either,
because Squads upgrades do not update the on-chain IDL account (see **Upgrade
Rule**). That date covers those two tables and nothing else in this repository.

Read the stamp it replaces as a warning rather than a precedent. It claimed a
2026-09-05 re-verification of *both* tables while mainnet's Version, Deployed,
and Expected IDL hash rows were a full release stale — a proof stamp standing
over rows it never covered, which is worse than no stamp because it stops the
next reader looking. Re-derive rather than trust:

```bash
# Upgrade authority (the "Authority" line), last deploy slot, and program size:
solana program show DaFv83yokwTz8msP9CzJ13eazSGk15NuUTxjkfzJzxMM --url mainnet-beta
solana program show EQGFJAcABtDb6VXtiijTjZ6cE2UqdvhnqJvoharJbpMJ --url devnet

# The Deployed row, from the slot each command above prints:
solana block-time 425788802 --url mainnet-beta
solana block-time 468716417 --url devnet

# The Program SHA256 row. Two dumps taken minutes apart are byte-identical, so
# this is a stable fingerprint of the bytes actually executing on chain:
solana program dump DaFv83yokwTz8msP9CzJ13eazSGk15NuUTxjkfzJzxMM /tmp/mainnet.so --url mainnet-beta
shasum -a 256 /tmp/mainnet.so
solana program dump EQGFJAcABtDb6VXtiijTjZ6cE2UqdvhnqJvoharJbpMJ /tmp/devnet.so --url devnet
shasum -a 256 /tmp/devnet.so

# The signer rows and Threshold live in the VaultState PDA, seeds [b"vault"].
# `solana account` alone prints a base64 blob: the signers are raw 32-byte
# arrays, so the account has to be decoded before it says anything. Both PDA
# addresses and the decode are under "Reading the signer set off the chain".

# The live consumer pin, and the file it must equal. Run this pair from the
# turf-vault repo root, with turf-monster checked out beside it. Read the config
# as JSON: `heroku config:get` prints an identical bare newline for "absent" and
# for "present but empty", and that ambiguity has already produced a wrong reading.
heroku config --app turf-monster-mainnet --json | jq -r '.EXPECTED_IDL_HASH'
shasum -a 256 ../turf-monster/config/turf_vault.mainnet.idl.json
```

### Reading the Version row off the chain

The deployed executable carries no version string — a `strings` scan of a
mainnet dump finds no `x.y.z` literal anywhere in it — so the version label
cannot be read directly, and it must never be inferred from a commit message.
Read it instead from the instruction set the binary dispatches. Anchor keys
each instruction by the first eight bytes of `sha256("global:<name>")`, and
those constants are compiled into the program:

```bash
solana program dump DaFv83yokwTz8msP9CzJ13eazSGk15NuUTxjkfzJzxMM /tmp/mainnet.so --url mainnet-beta
ruby -rdigest -e 'b = File.binread("/tmp/mainnet.so"); %w[admin_create_user_account admin_set_username burn_entry_token].each { |n| puts "#{n}: #{b.include?(Digest::SHA256.digest("global:#{n}")[0, 8]) ? "PRESENT" : "absent"}" }'
```

On 2026-09-07 mainnet answered **PRESENT** for `admin_create_user_account` and
`admin_set_username` — the two instructions v0.25.0 added — and **absent** for
`burn_entry_token`, the only instruction added since. Devnet answered
identically. The absence is the control: it shows the probe discriminates
rather than matching whatever it is handed. So mainnet dispatches v0.25.0's
instruction surface, not v0.24.0's and not the unreleased tree's.

> **THE PROBE ABOVE GOES BLIND THE MOMENT v0.26 LANDS — use the second one
> below from that day on.** v0.26 DELETES `admin_create_user_account` and
> `admin_set_username`, so after the upgrade every name in that command answers
> **absent**, including the control. "absent, absent, absent" matches no row in
> this section, and the natural reading of a probe that finds nothing is that
> the dump or the command is wrong — not that the binary moved on. Swap the
> names rather than the conclusion:
>
> ```bash
> ruby -rdigest -e 'b = File.binread("/tmp/mainnet.so"); %w[init_governance set_action_threshold overwrite_username reserve_username backfill_username_record admin_set_username].each { |n| puts "#{n}: #{b.include?(Digest::SHA256.digest("global:#{n}")[0, 8]) ? "PRESENT" : "absent"}" }'
> ```
>
> On a v0.26 binary the first five answer **PRESENT** and `admin_set_username`
> answers **absent** — and that last one is the control, in the same way
> `burn_entry_token` was the control for the v0.25 reading: a probe where
> everything answers PRESENT is a probe that has stopped discriminating. Until
> the upgrade lands, the v0.25 command above is still the right one and its
> 2026-09-07 measurement still stands.

The pinned IDL agrees from the other side, and it is the weaker of the two
readings: `EXPECTED_IDL_HASH` on `turf-monster-mainnet` is the sha256 of
`turf-monster/config/turf_vault.mainnet.idl.json`, which declares
`metadata.version` `0.25.0` against address `DaFv83...`. Weaker because it reads a
file in another repo rather than the chain: the pin proves which IDL
turf-monster is configured to ACCEPT, never which program is executing. Since
2026-09-15 the crate version does at least distinguish the two — a freshly
built IDL now reads `0.26.0`, where before it also read `0.25.0` and nothing
separated them. turf-monster still carries the proof of that: its staged
`config/turf_vault.mainnet.v026.idl.json` declares `metadata.version` `0.25.0`
against this same `DaFv83...` address while describing the 28-instruction v0.26
program, indistinguishable by label from the 22-instruction file beside it. It
reads `0.26.0` once rebuilt from the corrected tree. That improves the label
without promoting it: the version is still written by hand, so the discriminator
probe stays the reading that decides.

**What neither reading proves.** An instruction set fixes the release, not the
build — a patch inside a handler leaves every discriminator unchanged. The
Program SHA256 row is the only line here that pins the executing bytes, and it
has no committed counterpart to compare against, because `anchor build` is not
byte-reproducible across toolchains. Treat it as a drift detector: if it moves
and no Squads upgrade was executed, something is wrong.

### Reading the signer set off the chain

`VaultState` stores its signers as raw 32-byte arrays, so `solana account`
alone hands you a base64 blob and a comment naming byte offsets. This decodes
it in place and leaves nothing further to convert — it ends in three pubkeys
and a threshold, which is what the table rows above claim.

It is a plain public RPC read: no configured keypair, no Heroku, no
`turf-monster`, no app credential. That independence matters most during an
incident, when the app whose key you are rotating is the thing you cannot
trust. Run cold on **2026-09-07** to prove that: the block below extracted
from this committed file, then executed under `env -i` with an **empty
`HOME`**, macOS's stock `/usr/bin/ruby` (2.6.10), and nothing on `PATH` but
`solana` and the system directories. Both clusters came back complete, and
pointing it at the program ID instead of the PDA aborted `not a VaultState: 36
bytes, expected 1515`.

The first line selects mainnet; uncomment the second instead for devnet. Both
program IDs are the deployed IDs above, and each `VaultState` address is the
PDA of seeds `[b"vault"]` under its own program.

```bash
export CLUSTER=mainnet-beta PROGRAM=DaFv83yokwTz8msP9CzJ13eazSGk15NuUTxjkfzJzxMM VAULT=GBu44HFJjq61WnS9UV1twcSrCC6SkuXHK8RM6tUKsWzV
# export CLUSTER=devnet     PROGRAM=EQGFJAcABtDb6VXtiijTjZ6cE2UqdvhnqJvoharJbpMJ VAULT=J7b5g9uS5M2Nog1Ly1UATXTDMtXdpXK3JffRAHXGHkK2

solana account $VAULT --url $CLUSTER --output json |
ruby -rjson -rbase64 -e '
  a = JSON.parse(STDIN.read)["account"]
  d = Base64.decode64(a["data"][0])
  abort "not a VaultState: #{d.bytesize} bytes, expected 1515" unless d.bytesize == 1515
  abort "wrong program: account is owned by #{a["owner"]}" unless a["owner"] == ENV.fetch("PROGRAM")
  alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
  b58 = ->(raw) {
    n = raw.unpack1("H*").to_i(16)
    out = +""
    until n.zero?
      n, rem = n.divmod(58)
      out.prepend(alphabet[rem])
    end
    "1" * raw.bytes.take_while(&:zero?).size + out
  }
  3.times { |i| puts "signer[#{i}]           #{b58.(d[8 + 32 * i, 32])}" }
  puts       "threshold            #{d[104].ord}"
  puts       "paused               #{d[106].ord}"
  puts       "payout_mint          #{b58.(d[107, 32])}   <- control"
  puts       "treasury_authority   #{b58.(d[139, 32])}"
'
```

Offsets come from `VaultState` in `programs/turf_vault/src/state.rs`: an 8-byte
Anchor discriminator, then `signers[3]` at **8 / 40 / 72**, `threshold` at
**104**, `bump` 105, `paused` 106, `payout_mint` 107, `treasury_authority`
**139**, for **1515** bytes in total.

**What checks the read — three things, and none of them costs another command.**

1. **Length.** A non-`VaultState` address aborts by name rather than printing a
   plausible-looking set. Pointed at the program ID instead of the PDA it says
   `not a VaultState: 36 bytes, expected 1515`, and exits non-zero.
2. **Owner.** The account must be owned by `$PROGRAM`, so a `VaultState` from
   the *other* cluster — or from the orphaned old devnet program named under
   **Devnet** above — aborts too. That address is base58 the CLI produced, not this decoder.
3. **`payout_mint` — the control on the decoder itself.** On **mainnet** it MUST
   read `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, Circle's USDC mint. That
   is a **program invariant, not a deployment coincidence**: a mainnet build pins
   it at `initialize` and refuses any other mint
   (`initialize.rs:101-104`, inside the `#[cfg(feature = "mainnet")]` block
   opened at `:95`), and `state.rs:47-50` defines that constant with the base58
   spelling written beside its bytes at `:45`. So a wrong alphabet, a wrong
   encoder loop, or wrong offsets could not read as USDC — and offset 107 sits
   three bytes past `threshold`, so even a one-byte slide breaks it. On
   **devnet** the field is the devnet test mint
   (`222Dcu2RgAXE3T8A4mGSG3kQyXaNjqePx7vva1RdWBN9`) and no compile-time constant
   pins it, so the control is weaker there; checks 1 and 2 still hold.

`treasury_authority` is printed because it is the Squads vault PDA — the
**Upgrade authority** row above — so this one read also cross-checks that row.
It is **not** used as the control, and neither is `solana program show`:
that command refuses to run without a local default keypair (`No default signer
found`) even though it only reads, and this read must not depend on the machine
having one.

This is the same read as [`KEY_ROTATION.md`](KEY_ROTATION.md) §0 **Verifying
this yourself** B, decoding the same offsets — deliberately, so a rotation and
this reference cannot disagree about what the vault holds. Change one and change
the other.

`VaultState`'s in-program 2-of-3 is a separate mechanism from the Squads vault
that holds the program upgrade authority, and **they no longer even have the same
shape**. `VaultState` is still 2-of-3 with the signers listed in the tables above;
both Squads multisigs are 3-of-5 as of 2026-09-15. Two multisigs, two vocabularies
— see **Squads Governance** below, and read `scripts/squad.json`'s `_members_are`
note before touching that file.

## Squads Governance — who can upgrade, per cluster

**Do not read the membership out of this section.** It is a snapshot, it changed
twice on 2026-09-15 alone, and every written copy of it has gone stale faster than
anyone re-read it. The live answer is one command:

```bash
node scripts/squad-inventory.js              # both clusters, read-only, no keys
node scripts/squad-inventory.js --cluster=mainnet
```

What it reports, and what the numbers mean, as of **2026-09-15**:

| Cluster | Multisig | Threshold | Agent-held seats | An upgrade run would |
|---------|----------|-----------|------------------|----------------------|
| devnet | `7nRuVw3VZFC6z85tYVDitPnaUHZCkqLpJRSTBNtPmtZB` | 3 of 5 | 3 — `system.devnet` `2eGs8G3w…`, `admin` `BLSBw8fX…`, Xan `8K81w4e6…` | run **AUTONOMOUS**, end to end |
| mainnet | `4H3fP3otjMtupk1DQDjKXYY1dWjT6LNM4H4ZWZ1XcKSX` | 3 of 5 | 2 — `system` `7auwTLSv…`, `admin` `BLSBw8fX…` | **HAND OFF** one approval and the execute to Mr. McRitchie |

**The asymmetry is the design, not a gap.** Devnet is meant to run unattended;
mainnet is meant to need Mr. McRitchie. His three wallets — `7ZDJp7FU…` (Alex
Phantom), `3Qj4v9qj…` (Alex two), `9gACbz…` (Alex three) — sit on mainnet, and any
one of them closes the mainnet quorum. Mainnet crossing into AUTONOMOUS is a
governance regression to investigate, and devnet falling out of it is a broken
automation lane; `squad-inventory.js` prints either in one line.

Every seat holds mask 7 (Initiate|Vote|Execute) today, so any agent seat can open
a transaction and cast a vote. Confirm rather than assume — the mask, not the
membership, is what decides whether a seat can do the step being asked of it.

**Retired 2026-09-15, with Mr. McRitchie's authorization:** Xan `8K81w4e6…` off
mainnet (still seated on devnet) and Mason `CytJS23p…` off both. Neither is a
Squads member on the cluster the old tooling named them for. They remain
`VaultState` signers, which is a different multisig — see above.

The scripts that ran that rotation are preserved in
[`scripts/ceremony/`](../scripts/ceremony/README.md), with what each one did and
the three failure modes they found the hard way. They are a record, not a
toolkit: each validates its plan against live membership and now refuses.

## Upgrade Rule

`anchor deploy` is not the upgrade path for an existing deployed program under
Squads authority. Build the program, write a buffer, set the buffer authority to
the Squads vault PDA, then execute the upgrade through `scripts/squad-upgrade.js`:

```bash
node scripts/squad-upgrade.js --cluster=mainnet <BUFFER_ADDR>          # dry run
node scripts/squad-upgrade.js --cluster=mainnet <BUFFER_ADDR> --send   # armed
```

`--cluster` is required and has no default; the run is a dry run until `--send`.
A dry run reads no key material at all, so it is free to run before the buffer
even exists — which is the order the money wants, because a mainnet buffer costs
~2.76 SOL to write.

After any upgrade, re-pin Turf Monster from the built IDL, not from `anchor idl
fetch`; Squads upgrades do not update the on-chain IDL account.
