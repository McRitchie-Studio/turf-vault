# Current Deployment

This is the live operator reference for TurfVault deployment identity. Keep historical launch and rotation plans separate from this file.

## Devnet

| Field | Value |
|-------|-------|
| Program ID | `EQGFJAcABtDb6VXtiijTjZ6cE2UqdvhnqJvoharJbpMJ` |
| Version | v0.26.0 |
| Deployed | 2026-10-12, slot `510279923` (Squads devnet transaction #20; card `devnet-v026-upgrade`) |
| Upgrade authority | Squads V4 vault PDA `BW13kgfiG2koFn3WRkte21NW9TFygsD1ge2fNJdjH6kC` |
| `GovernanceConfig` | `729Q8AVBSV4fovTk9G74aoLwH6eChZT4DESzVAoGVS8J`, created by `init_governance`; shipped defaults except `settle_contest` = **2** (devnet only, `scripts/set-devnet-threshold.js`) |
| `VaultState` signers | five slots, read off chain after the EVICT (`node scripts/check-signer-slots.js --cluster devnet`) |
| slot 1 | `2eGs8G3wzhEeNQQU2Q86BmmA2xTpDbMMae3Y1bvpZfx9` — `solana.turf.system.devnet`, turf-monster-qa's `SOLANA_ADMIN_KEY` |
| slot 2 | `foUuRyeibadQoGdKXZ9pBGDqmkb1jY1jYsu8dZ29nds` — Mack (`agent.mack.solana`), the devnet-only rehearsal co-signer |
| slot 3 | `BVQHNwUEo91ePwqPcR6Ro4g9Ejqt3qn3ajKPqJSSTd51` — `solana.turf.governance.devnet` (admin vault), devnet-only |
| slot 4 | `9gACbzsCLmkYF9Yx1EBGmwMvvyfuTquJ6qs8QsoQvHXf` — Mr. McRitchie, Phantom account 2 |
| slot 5 | `3Qj4v9qjhXgkru6zCRCErRVhy8Q6qU3NrNpvpXLTZboA` — Mr. McRitchie's second wallet |
| Program SHA256 | `af3d1cdf3e35ec0348249db775f61d3d565ef4ca5a025ef80409128f785eb6b9` (707,328 bytes, the whole region; its first 706,304 bytes are the built `turf_vault.so`, `76a8db25…`) |
| Consumer pin | turf-monster-qa `EXPECTED_IDL_HASH` = v0.25 `f11446fa…` + v0.26 `2d9f7151…`, `SOLANA_VAULT_GOVERNANCE=on` |
| USDC test mint | `222Dcu2RgAXE3T8A4mGSG3kQyXaNjqePx7vva1RdWBN9`, mint authority `2eGs8G3w…` (QA's server key) since 2026-10-12, so QA mints its own rehearsal pools. It was `8K81…` until then; local development, which derives `8K81…`, can no longer mint devnet USDC |
| USDT test mint | `9mxkN8KaVA8FFgDE2LEsn2UbYLPG8Xg9bf4V9MYYi8Ne`, supply 0, mint authority still the leaked `F6f8...KzhZ` (read 2026-10-12). Nothing mints it; move it before anything does |

**No mainnet `VaultState` signer is seated on devnet.** `8K81…` (production's
server key) and `CytJ…` (Mason) left devnet in the EVICT; `7ZDJ…` left in the
v0.25 swap before the upgrade. `9gAC…` and `3Qj4…` are mainnet Squads members and
the mainnet rotation's target, not mainnet `VaultState` signers today.

**`9gAC…` and `3Qj4…` must leave the devnet `VaultState` when the mainnet rotation
seats them.** The step: in the same sitting as the mainnet EVICT that seats them
(card `mainnet-v026-upgrade`, `SIGNER_ROTATION.md`), Steffon runs one devnet
`update_signers` with `node scripts/rotate-devnet-signers.js`, replacing both with
devnet-only keys, signed by the three devnet agent keys `2eGs` + `foUu` + `BVQH`
(no human tap). The replacements are two fresh devnet-only keys filed in the
admin vault, unless Mr. McRitchie names devnet-only wallets of his own. The same
rule holds for any key the mainnet rotation adds: no key is a `VaultState` signer
on both clusters. turf-monster's `config/mainnet_vault_signers.yml` already fences
both from the QA rehearsal.

The devnet signer change ran in four devnet transactions, all agent-signed under
Mr. McRitchie's devnet-only grant:

| Step | Set written | Signed by | Signature |
|------|-------------|-----------|-----------|
| v0.25 swap | `8K81, 2eGs, CytJ` | `8K81` + `CytJ` | `4mQTE8XisEMPUHpURZtZzZH7J3fZdzouooTihZuuXd29wXrkLSXq4PnAGL1QeHcX2jfJUj7dXGhCQGTHk9kLEvgb` |
| `init_governance` | — | `2eGs` + `8K81` | `36Kdhj6gFLaJo63QG5dp7fmb8pg7NM7JqZj6jCvVTwhgQwkATf1zjBUqnj7QkwWHwAfZnjGZsHsU9yGcu7D8TiSR` |
| ADD | `8K81, 2eGs, CytJ, foUu, BVQH` | `2eGs` + `8K81` + `CytJ` | `2VZepg7KRFG4Gv8Z9UEW8twSL1bJtoMFJiyVdaVfzXuL6fRwWmY5s9rfPC9UaKL5sCA7Q8NtyxsqyXjAGhmfzTzs` |
| EVICT | `2eGs, foUu, BVQH, 9gAC, 3Qj4` | `2eGs` + `foUu` + `BVQH` | `3CfnL5pcacmHt1kXPtrYxf2QtKpiYA5245uyaZN472j7HFRnshfgq39P7iRTV1x77sjyd3HsFZJ8HwR8hRmEPbiv` |
| `settle_contest` → 2 | — | `2eGs` + `foUu` + `BVQH` | `2kuQ4zhtjahYw1KHLQS9y7bJPAY8p7ipiZL9KTg4Kfp1BBB4m91iarSEVutRtWe3B9fgZAq9eVeDuw3ufysy8KWK` |

The upgrade itself: buffer `BmYZP4v6zKzLYZBPMYYEq9h3VPaGT2JWv3WJsXjQioV4`
(rent spilled to Mack), ProgramData extended by 162,696 bytes
(`4EYfWTNFLQNv5Nb7WXa31MWXT2mL8t7oeRpu3sK8Ptm5qisvqx3jzzDd7kTqwsasuVcMaLKAEWwcyXXeToJxJQVv`),
executed `3bhF2Mk9TGbtiuqZk75KSU5aCQYdhk4GNQZ5dPWFsPSZUPB638J4Xu5Vc9yay7N3k8JDiLWJ7hkfibHx7nhSfWhh`.
**Rollback:** the v0.25.0 dump (`a0611d29…`, 544,632 bytes) written to a buffer
and upgraded through the same Squad; then unset `SOLANA_VAULT_GOVERNANCE` on QA.
The `GovernanceConfig` account and the five-slot set stay, and v0.25 ignores both
(it reads only slots 1–3 and validates two signers).

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

**The FIRST mainnet deployment was retired on 2026-09-16.** `MAINNET_LAUNCH.md` was executed against a program that is not the one above. Squads multisig `9dCLMZct…` was created on 2026-05-26 at 2-of-3 with `7ZDJp7FU…`, `F6f8...KzhZ` and `CytJS23p…`. Program `mnzowM2F…` was deployed from `F6f8...KzhZ` at 2026-06-02 08:56:16Z, and its authority passed to that Squad's vault `83BXrVFB…` 19 seconds later. The Alex Bot leak then forced the `KEY_ROTATION.md` redeploy onto `DaFv83yo…` later that day. The old deployment stayed un-retired, with the leaked key still seated on its Squad, until two Squads transactions on the evening of 2026-09-16 (MDT), both executed by Mr. McRitchie's `7ZDJp7FU…`. Read at `finalized` afterwards:

- **`mnzowM2F…` is closed** (`KEY_ROTATION.md` §8). Vault transaction #1 on `9dCLM…`, executed 2026-09-17 02:27:09Z, closed it and sent its 3.50 SOL of ProgramData rent to `Bk9sS7ii…`, the live upgrade-authority vault above. A closed program ID can never be deployed again.
- **`9dCLMZct…` is retired** (`KEY_ROTATION.md` §7). Config transaction #2, executed eleven minutes later, removed `F6f8...KzhZ` and `CytJS23p…` and set the threshold to 1. `7ZDJp7FU…` is its only member. Squads v4 cannot close a multisig, so the account persists, controlling nothing.
- Its `VaultState` still lists `F6f8...KzhZ`, `7ZDJp7FU…` and `CytJS23p…` at threshold 2, and always will: nothing can rewrite an account owned by a closed program. No program is left to read those bytes, so they authorize nothing.
- It held 0 USDC and 0 USDT, and `turf-monster-mainnet`'s `SOLANA_PROGRAM_ID` is `DaFv83yo…`, not it.

So "`F6f8` holds no mainnet authority" is now true of both mainnet deployments, not only the live one. Its devnet leftovers, including its signer slot in the orphaned `Dx8u…` vault, are under **Devnet**. Signatures for both transactions are recorded in `KEY_ROTATION.md` §7–§8.

**Devnet runs v0.26.0 since 2026-10-12; mainnet runs v0.25.0** (reached 2026-06-11). The next upgrade window carries `burn_entry_token` AND the v0.26 governance change (both Unreleased in `CHANGELOG.md`), which change the IDL and so need a freshly built `EXPECTED_IDL_HASH` pinned on `turf-monster-mainnet`. The Version row above is read off the deployed executable, not inferred from a commit message; the method is under **Verification** below.

**The crate version is not this row.** `programs/turf_vault/Cargo.toml` reads `0.26.0` as of 2026-09-15: that is what the SOURCE is, and it is the label a freshly built IDL will carry. The mainnet table says v0.25.0 because that is what the mainnet CHAIN runs; devnet agrees with the crate since 2026-10-12. Mainnet agrees only after its upgrade window. Reading `0.26.0` in the crate and concluding these rows are stale is the mistake this paragraph exists to prevent.

**Thresholds differ by cluster.** Mainnet's row is v0.25's 2-of-3
(`validate_multisig` takes exactly two signers). Devnet's are v0.26's per-action
table in `GovernanceConfig` (devnet table above); the v0.26 table in
`CHANGELOG.md` describes mainnet only after its upgrade.

When v0.26 lands on mainnet, the mainnet rows need re-deriving and one step must
not be skipped: `init_governance` runs immediately after the upgrade, because
every vault-authorized instruction requires the account it creates (`RUNBOOK.md`
→ *v0.26 Upgrade Ordering*). The signer rows do NOT change at deploy: the two
appended slots read as empty until the ceremony in `SIGNER_ROTATION.md` runs.
`node scripts/check-signer-slots.js --cluster <devnet|mainnet>` reads all five
slots and is the cheapest way to re-derive either table's signer rows. Read on
2026-10-12, devnet holds the five keys in its table and mainnet still holds
`8K81…`, `7ZDJ…`, `CytJ…` with slots 4 and 5 empty.

**The upgrade authority is per cluster.** Mainnet's Squads vault PDA (`Bk9sS7ii...`) is a different vault from devnet's (`BW13kgfi...`). Never carry one cluster's vault address to the other; the devnet address is the one that historically leaked into mainnet-facing prose. The `VaultState` signer sets DIFFER since 2026-10-12 (devnet holds no mainnet signer), and nothing in the program ties them together — each cluster's `VaultState` was written by its own `initialize`, and `update_signers` can move one without the other. Read the cluster you mean.

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
This recipe prints the three v0.25 slots only. v0.26 appends `signers_ext[2]`
at offset 1443, and devnet fills all five: read either cluster's full set with
`node scripts/check-signer-slots.js --cluster <devnet|mainnet>`.

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
shape**. Mainnet's `VaultState` is still v0.25's 2-of-3 and devnet's is v0.26's
five slots with per-action thresholds (the tables above);
both LIVE Squads multisigs are 3-of-5 (since 2026-09-15, and re-read at
`finalized` on 2026-09-16). The retired first mainnet Squad `9dCLM…` is 1-of-1 and
governs nothing (see **Mainnet**). Two multisigs, two vocabularies
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

What it reports, and what the numbers mean, as of **2026-10-12**. Devnet was
re-read at `finalized` after devnet #21; mainnet at `confirmed` after mainnet #6:

| Cluster | Multisig | Threshold | Agent-held seats | An upgrade run would |
|---------|----------|-----------|------------------|----------------------|
| devnet | `7nRuVw3VZFC6z85tYVDitPnaUHZCkqLpJRSTBNtPmtZB` | 3 of 5 | 3 — `system.devnet` `2eGs8G3w…`, `seat-a.devnet` `GF4sojG9…`, `seat-b.devnet` `39qaSh2J…` | run **AUTONOMOUS**, end to end |
| mainnet | `4H3fP3otjMtupk1DQDjKXYY1dWjT6LNM4H4ZWZ1XcKSX` | 3 of 5 | 2 — `system` `7auwTLSv…`, `governance` `4bKNSqkr…` | **HAND OFF** one approval and the execute to Mr. McRitchie |

**The asymmetry is the design, not a gap.** Devnet is meant to run unattended;
mainnet is meant to need Mr. McRitchie. His three wallets — `7ZDJp7FU…` (his
Phantom), `3Qj4v9qj…` (his second), `9gACbz…` (his third) — sit on mainnet, and any
one of them closes the mainnet quorum. Mainnet crossing into AUTONOMOUS is a
governance regression to investigate, and devnet falling out of it is a broken
automation lane; `squad-inventory.js` prints either in one line.

Every seat holds mask 7 (Initiate|Vote|Execute) today, so any agent seat can open
a transaction and cast a vote. Confirm rather than assume — the mask, not the
membership, is what decides whether a seat can do the step being asked of it.

**Retired 2026-09-15, with Mr. McRitchie's authorization:** Xan `8K81w4e6…` off
mainnet and Mason `CytJS23p…` off both live Squads — mainnet config transaction
#3 at 09:46 MDT, devnet #16 at 09:41 MDT. Xan also left devnet in that #16 and
was re-seated there at 14:02 MDT (#18); devnet #21 (below) removed him again on 2026-10-12. Neither is a Squads member on
the cluster the old tooling named them for. They remain `VaultState` signers,
which is a different multisig — see above.

**Rotated out of both clusters 2026-10-09: the exposed `admin` seat
`BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo`** (`solana.turf.admin`, which had sat
in local env files on many desks). One config transaction per cluster,
`RemoveMember BLSBw8…` + `AddMember 4bKNSqkrKeggSyrds16Ak7rcB4ibvGJ4ZLsKjvQgC3Vk`
(mask 7), threshold unchanged, built by
[`scripts/ceremony/rotate-admin-seat.js`](../scripts/ceremony/rotate-admin-seat.js).
The new `governance` key is filed as `solana.turf.governance` in the ADMIN vault
`studio-agents-admin`, which a desk-level agent token cannot open. BLSBw8 created
neither transaction and executed neither. It cast ONE vote, devnet #19's third,
under the exception described below the table.

| Cluster | Config tx | Created | Approved by | State |
|---------|-----------|---------|-------------|-------|
| mainnet | #6 | 2026-10-08 20:36 UTC by `system` `7auwTLSv…` | `7auwTLSv…`, `3Qj4v9qj…`, `7ZDJp7FU…` | **Executed** 2026-10-09 16:42:51 UTC (10:42 MDT), by Mr. McRitchie in the Squads app |
| devnet | #19 | 2026-10-08 by `system.devnet` `2eGs8G3w…` | `2eGs8G3w…`, Xan `8K81w4e6…`, the outgoing `BLSBw8fX…` | **Executed** 2026-10-09 16:48:36 UTC (10:48 MDT), by `system.devnet` `2eGs8G3w…` |

**Devnet's third approval was the outgoing key itself, on Mr. McRitchie's
instruction.** No Squads UI reaches the devnet Squad for his wallets, so his tap
was not possible there. He ruled that morning (relayed as 10:50 MDT; the vote
landed at 10:48 MDT by the chain's clock) that the agent's three devnet seats
should finish it. The third agent seat was BLSBw8. It approved its own removal
and nothing else, through `rotate-admin-seat.js --allow-outgoing-signer`, which
is refused on mainnet (cluster and genesis) and for create and execute. Mainnet
needed two of his own wallets and got them.

**BLSBw8 is emptied and archived.** On Mr. McRitchie's ruling, after both swaps
read Executed, `scripts/ceremony/sweep-admin-seat.js` moved its mainnet SOL:
0.5 SOL to `4bKNSqkr…` (`VxQ5DSDv…`), 3 SOL to `7ZDJp7FU…` (`5PEBmzSN…`), and the
remaining 0.076570239 SOL to `7ZDJp7FU…` (`3MzbCGCE…`). All three are finalized,
and BLSBw8 reads 0 SOL. `solana.turf.admin` is archived in `studio-agents`. No
Heroku config value on `turf-monster-mainnet` or `turf-monster-qa`, and no local
`.env*` file, derives to it. Its two mainnet token accounts (19.841973 USDT,
0.0011 USDC) were emptied into `7ZDJp7FU…`'s accounts and closed, with the rent
to `7ZDJp7FU…`, in one transaction paid by `4bKNSqkr…` (`2Xs3xJxz…`). BLSBw8 owns
no token accounts.

**Xan's key moved to the admin vault the same day.** `agent.xan.solana` (`8K81…`) is
production's `SOLANA_ADMIN_KEY`. It now lives in `studio-agents-admin`; the
`studio-agents` original is archived. It is no longer a Squads seat on either
cluster (devnet #21, below).

**Rotated off devnet 2026-10-12: `8K81…` and `4bKN…`, both printed into a
transcript that day** (activity-17894; card `devnet-exposed-keys-tidy`). ONE
devnet config transaction, #21: `RemoveMember 8K81…`, `RemoveMember 4bKN…`,
`AddMember GF4sojG9tHF2kC3jpgto1gd3b1nXLuUiAcsAiYi5Y5vb` (mask 7), `AddMember
39qaSh2J4VoQhn3sZCwWmb1W17VCrDMri2JoBAN6dT1o` (mask 7), threshold unchanged at
3 of 5. The two new keys are DEVNET-ONLY, generated straight into 1Password as
`solana.turf.squad-seat-a.devnet` and `solana.turf.squad-seat-b.devnet`
(`studio-agents-admin`); neither is in any `VaultState` signer set or on the
mainnet Squad. `2eGs` created, paid and executed; `2eGs`, `4bKN` and `8K81`
approved, each outgoing key voting once for its own removal under Mr.
McRitchie's devnet-only grant. Read back at `finalized`: `2eGs`, `39qa`, `3Qj4`,
`7ZDJ`, `GF4s`. `4bKN` stays a MAINNET seat; this changed devnet only.

| Step | Signature |
|------|-----------|
| `configTransactionCreate` #21 | `4SEY2acMUr2AYfuvM5Cm6v9qX1VqgbWBVGTQQXmZadR3WEDMZJPLZgMqyREhDNJHsHGTUbDrvwzfYumVZzGrufSv` |
| `proposalCreate` | `r92PDevrTsujbFeqbQBrq4DBFV12BDAZad8Ab3aZ2WccuvpARP8DGb6dUkoSMqw2bxbxMH92PN8tHHoKhbGwVoG` |
| approve `2eGs` | `2hPa5grr5eYyfDgcQc45WFMT36n76gt1HKYSV3fTz74SHzYNBUeBMq8aztLH37xT7TX9kGDdJCkDuydy5e3TyzEm` |
| approve `4bKN` | `2rEd2jCaP4cpQCPZ71i1KFeY5Tn6HHnFVD8cBPHhq3rebtWRHqK1pa4UdWCrv5qDDpJfTDNCTnTc86VpAUvv4t4D` |
| approve `8K81` | `6vjCrpMhau466ibEcE9cHCncyBpzEM8KuXA3JBFBoGf3J8mXHZhn5w74nH9xFcpiVykNgWQTLCq7DVzQvyZ93SF` |
| `configTransactionExecute` | `32QhTm82GPzSCLPYBuSFAtvzTr1aQUfjFFJyVv1qaDxRwFX4EGew31KwsUEW42mniFwux5iBKd17eyDAvPSvsg4P` |

The same sitting moved the devnet USDC test mint's authority from `8K81…` to
`2eGs…` (`SetAuthority`, signed by `8K81`, paid by `2eGs`:
`5oW2NZM1MRJ6K5a5Aev7RM1SvfAjxdV1Xt2mfzq6gYamndrcCre7GvBCnPWKqfbWZZYRKCjaEi2NCX2PeW813STm`)
and minted 2,000 devnet USDC to `2eGs`'s token account `nZBhH1hy…`
(`ur8G88TK8bMY6WfhT29U4bJscR46n8RUDAVVhwCjrnErSJ67JNWVgyt18xJZwzk7Gf4HkobFxP87x9oHHM7e3PV`).

Devnet #17 (2026-09-15, `AddMember 7auwTLSv…`, one approval, by BLSBw8) still reads
Active and is left in place. Its index is at or below devnet's
`staleTransactionIndex` (18 then, 19 after #19), so the program will not approve
or execute it. That is
read from the account, not tested on chain.

**Retired 2026-09-16, signed by Mr. McRitchie:** the first mainnet Squad
`9dCLMZct…`, which the table leaves out because it governs nothing. It closed the
program it held (`mnzowM2F…`), then removed `F6f8...KzhZ` and Mason and dropped
to 1-of-1 with `7ZDJp7FU…` alone. `squad-inventory.js` does not read it. The
detail is under **Mainnet** above; the signatures are in `KEY_ROTATION.md` §7–§8.

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
node scripts/squad-upgrade.js --cluster=mainnet <BUFFER_ADDR> \
  --spill=Bk9sS7iiSRL18vuo2KVzkeGw7EekKqxMCjrdoyGGdJm \
  --expect-buffer-sha256=<sha256 of the reviewed .so> --send           # armed
```

`--cluster` is required and has no default; the run is a dry run until `--send`.
A dry run reads no key material at all, so it is free to run before the buffer
even exists — which is the order the money wants, because a mainnet buffer costs
~2.76 SOL to write.

A mainnet `--send` refuses, before any key is read or anything is signed, unless
all three hold:

- `--spill` is given and is the Squad vault, so the buffer's rent refund goes
  back to the vault, never to an agent seat.
- The buffer's authority is the Squad vault. Mainnet runs a handoff, and whoever
  holds the buffer's authority could rewrite it between the agents' approvals
  and Mr. McRitchie's execute. Run `solana program set-buffer-authority` first.
- `--expect-buffer-sha256` equals the sha256 of the buffer's on-chain program
  bytes: everything after its 37-byte header, trailing zeros included.

**The expected hash comes from the reviewed `.so`, never from the dry run.** Take
it from `shasum -a 256 target/deploy/turf_vault.so` on the reviewed build, for a
buffer written without `--max-len`. The dry run prints `BUFFER SHA256`, the hash
it read from chain; use that only to check the buffer by eye. Pasting it into
`--expect-buffer-sha256` makes the gate compare the chain with itself. On mainnet
the dry run's `Arm with:` line carries `--spill` and a placeholder for the hash,
never the hash itself. Devnet is not gated.

After any upgrade, re-pin Turf Monster from the built IDL, not from `anchor idl
fetch`; Squads upgrades do not update the on-chain IDL account.
