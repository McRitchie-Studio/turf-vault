use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::instructions::governance::authorize;
use crate::state::{gov_action, GovernanceConfig, VaultState, MAX_SIGNERS};

/// `update_signers` — rotate the multisig signer set IN PLACE, without a
/// program redeploy.
///
/// ── WHAT v0.26 CHANGED, AND WHY IT IS THE POINT OF THE WHOLE TASK ─────────
///
/// The set is now up to FIVE slots and the threshold is real. The finding that
/// forced it: the live set was `{Alex Bot, Alex, Mason}` on both clusters at a
/// structural 2-of-3, and two of those three keys — Alex Bot and Mason — sit in
/// the same 1Password vault behind the same service account. They read as two
/// parties and are two COSTUMES of one agent system. Any agent with vault
/// access therefore held two of three signatures, which is every governance
/// power this program has, `update_signers` included: the agent could rotate
/// the operator out of his own vault.
///
/// The old continuity guard did not stop that. `SignerContinuityRequired` only
/// demanded that the two AUTHORIZING keys survive the rotation, and those were
/// exactly the two the agent already held.
///
/// The end state is five slots at three required: two agent-reachable (a
/// per-environment system wallet, and the agent's own identity) and three
/// personal wallets on separate devices. Two is never enough to govern and
/// never enough to evict; three is enough for the operator to govern alone on
/// the day he needs to.
///
/// ── THE ROTATION IS A TWO-STEP CEREMONY, BY CONSTRUCTION ──────────────────
///
/// Continuity requires that `threshold` of the keys that authorized a rotation
/// survive it. Today the vault holds three keys and `UPDATE_SIGNERS` requires
/// three, so all three authorizers must survive — meaning the FIRST rotation
/// can only ADD:
///
///   step 1   {bot, alex, mason} -> {bot, alex, mason, alex-2, alex-cold}
///            signed by all three current keys. Purely additive; nothing is
///            evicted, so continuity holds trivially.
///   step 2   {bot, alex, mason, alex-2, alex-cold}
///                -> {system, xan-bot, alex, alex-2, alex-cold}
///            signed by alex + alex-2 + alex-cold — three keys the agent
///            cannot reach — which is what makes this step an EVICTION the
///            agent cannot block or reverse.
///
/// That is not a limitation to work around; step 2 is the first moment the
/// operator can act without the agent's cooperation, and it only exists
/// because step 1 widened the set first.
///
/// ── AUTH ──────────────────────────────────────────────────────────────────
///
/// `gov_action::UPDATE_SIGNERS`, default 3, with an IMMOVABLE FLOOR of 3. The
/// floor is what stops the retuning mechanism from undoing the fix: without
/// it, three signatures could lower `update_signers` to two and the two
/// agent-reachable keys walk in the next day.
///
/// ── ACCOUNT LAYOUT ────────────────────────────────────────────────────────
///
/// `signers` (offset 0) and `signers_ext` (offset 1443, appended into the old
/// `_reserved`) are written as one logical array. No size change, no realloc,
/// no re-init — see the layout note on `VaultState`.
#[derive(Accounts)]
pub struct UpdateSigners<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    pub cosigner: Signer<'info>,

    #[account(mut, seeds = [b"vault"], bump = vault_state.load()?.bump)]
    pub vault_state: AccountLoader<'info, VaultState>,

    /// Per-action threshold table. Required by every vault-authorized
    /// instruction since v0.26 — see `instructions::governance::authorize`.
    #[account(seeds = [b"governance"], bump = governance.bump)]
    pub governance: Account<'info, GovernanceConfig>,
    // remaining_accounts: leading extra cosigners (threshold - 2).
}

pub fn handle_update_signers(
    ctx: Context<UpdateSigners>,
    new_signers: [Pubkey; MAX_SIGNERS],
) -> Result<()> {
    let admin_key = ctx.accounts.admin.key();
    let cosigner_key = ctx.accounts.cosigner.key();
    let required = ctx
        .accounts
        .governance
        .threshold_for(gov_action::UPDATE_SIGNERS);
    let max_live = ctx.accounts.governance.max_live_threshold();

    // AUTHORIZATION. Collect the authorizing keys as `authorize` does, because
    // the continuity check below needs to know WHICH keys signed, not merely
    // that enough of them did.
    let mut authorizers: Vec<Pubkey> = vec![admin_key, cosigner_key];
    let extra_needed = (required as usize).saturating_sub(authorizers.len());
    {
        let vault = ctx.accounts.vault_state.load()?;
        authorize(
            &vault,
            &ctx.accounts.governance,
            gov_action::UPDATE_SIGNERS,
            &[admin_key, cosigner_key],
            ctx.remaining_accounts,
        )?;
        for info in ctx.remaining_accounts.iter().take(extra_needed) {
            authorizers.push(info.key());
        }
    }

    // ── Shape of the proposed set ────────────────────────────────────────
    //
    // LEFT-PACKED, NO GAPS. `all_signers()` skips `Pubkey::default()`, so a set
    // like [A, 0, B, 0, 0] would still WORK — and that is precisely why it is
    // refused. A gap makes "how many signers does this vault have" depend on
    // where you look: slot 2 is occupied, slot 1 is not, and an operator
    // reading the raw account, a script counting to the first zero, and
    // `all_signers()` would each give a different answer. Refusing gaps makes
    // "empty" a suffix and only a suffix, so every reader agrees.
    let mut count: usize = 0;
    let mut seen_empty = false;
    for key in new_signers.iter() {
        if *key == Pubkey::default() {
            seen_empty = true;
        } else {
            // A live key AFTER an empty slot is a gap.
            require!(!seen_empty, VaultError::SignerSetTooSmall);
            count += 1;
        }
    }

    // No duplicate keys — a duplicated signer silently shrinks the effective
    // set (a 3-of-5 holding two copies of one key collapses to 3-of-4, and the
    // holder of the duplicate casts two of the three votes). Reuses 6014.
    for i in 0..count {
        for j in (i + 1)..count {
            require!(new_signers[i] != new_signers[j], VaultError::DuplicateSigner);
        }
    }

    // The set must be able to satisfy EVERY live action, not merely this one.
    // Rotating to a 2-key set while `settle_contest` needs three would brick
    // settlement with no route back except another rotation — and if the count
    // fell below `update_signers`' own threshold, there would be no route back
    // at all.
    require!(count >= required as usize, VaultError::SignerSetTooSmall);
    require!(count >= max_live as usize, VaultError::SignerSetTooSmall);
    require!(count <= MAX_SIGNERS, VaultError::SignerSetTooSmall);

    // ── Continuity (OPSEC-027, generalized to N-of-M) ────────────────────
    //
    // At least `required` of the keys that AUTHORIZED this rotation must
    // survive it. The old rule was "both authorizing cosigners survive", which
    // was the 2-of-3 spelling of the same idea.
    //
    // What it guarantees: after the write, the vault still holds `required`
    // keys someone has just DEMONSTRATED they can sign with. A weaker rule —
    // "keep at least one" — passes a rotation to [survivor, junk, junk, 0, 0]
    // that leaves governance permanently unreachable, because no second key
    // could ever cosign. A fat-fingered Phantom paste produces exactly that
    // set, which is why this catches a typo as well as an attack.
    //
    // What it does NOT do is prevent eviction: a key that did not authorize
    // the rotation may be dropped freely, which is how step 2 of the ceremony
    // above removes the agent-reachable slots.
    let surviving_authorizers = authorizers
        .iter()
        .filter(|k| new_signers[..count].contains(k))
        .count();
    require!(
        surviving_authorizers >= required as usize,
        VaultError::SignerContinuityRequired
    );

    let old_count = {
        let mut vault = ctx.accounts.vault_state.load_mut()?;
        let old_count = vault.active_signer_count();
        vault.signers = [new_signers[0], new_signers[1], new_signers[2]];
        vault.signers_ext = [new_signers[3], new_signers[4]];
        old_count
    };

    msg!(
        "Signers rotated by {} authorizer(s) (lead {} + {}). {} -> {} slots, {} required. New set: [{}, {}, {}, {}, {}]",
        authorizers.len(),
        admin_key,
        cosigner_key,
        old_count,
        count,
        required,
        new_signers[0],
        new_signers[1],
        new_signers[2],
        new_signers[3],
        new_signers[4],
    );
    Ok(())
}
