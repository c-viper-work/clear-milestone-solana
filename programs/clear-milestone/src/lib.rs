use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

// Replace with your deployment public key before building/deploying.
declare_id!("Fg6PaFpoGXkYsidMpWxTWqkZ7FEfcYkgMQHGdVQJQ5yQ");

#[program]
pub mod clear_milestone {
    use super::*;

    pub fn initialize_sprint(ctx: Context<InitializeSprint>, sprint_id: u64, amount_lamports: u64,
        kill_fee_bps: u16, arbiter_fee_bps: u16, review_window_secs: i64, spec_hash: [u8; 32]) -> Result<()> {
        checked(rules::validate_terms(amount_lamports, kill_fee_bps, arbiter_fee_bps, review_window_secs))?;
        let client = ctx.accounts.client.key();
        let contractor = ctx.accounts.contractor.key();
        let arbiter = ctx.accounts.arbiter.key();
        let escrow = ctx.accounts.sprint_escrow.key();
        require!(client != contractor && client != arbiter && contractor != arbiter && escrow != client && escrow != contractor && escrow != arbiter, EscrowError::DistinctParties);
        let s = &mut ctx.accounts.sprint_escrow;
        s.client = client;
        s.contractor = contractor;
        s.arbiter = arbiter;
        s.sprint_id = sprint_id;
        s.amount_lamports = amount_lamports;
        s.kill_fee_bps = kill_fee_bps;
        s.arbiter_fee_bps = arbiter_fee_bps;
        s.review_window_secs = review_window_secs;
        s.created_at = Clock::get()?.unix_timestamp;
        s.submitted_at = 0;
        s.auto_release_at = 0;
        s.spec_hash = spec_hash;
        s.deliverable_hash = [0; 32];
        s.deliverable_uri = String::new();
        s.dispute_hash = [0; 32];
        s.status = rules::FUNDED;
        s.bump = ctx.bumps.sprint_escrow;
        system_program::transfer(CpiContext::new(ctx.accounts.system_program.to_account_info(), Transfer {
            from: ctx.accounts.client.to_account_info(), to: s.to_account_info(),
        }), amount_lamports)?;
        Ok(())
    }

    pub fn submit_deliverable(ctx: Context<Act>, deliverable_hash: [u8; 32], deliverable_uri: String) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let out = ctx.accounts.outcome(rules::Action::Submit { uri_bytes: deliverable_uri.len() }, now)?;
        let s = &mut ctx.accounts.sprint_escrow;
        s.deliverable_hash = deliverable_hash;
        s.deliverable_uri = deliverable_uri;
        s.submitted_at = now;
        s.auto_release_at = out.auto_release_at;
        s.status = out.status;
        Ok(())
    }

    pub fn approve_deliverable(ctx: Context<Act>) -> Result<()> {
        ctx.accounts.settle(rules::Action::Approve, Clock::get()?.unix_timestamp)
    }

    pub fn claim_after_timeout(ctx: Context<Act>) -> Result<()> {
        ctx.accounts.settle(rules::Action::Claim, Clock::get()?.unix_timestamp)
    }

    pub fn cancel_before_submission(ctx: Context<Act>) -> Result<()> {
        ctx.accounts.settle(rules::Action::Cancel, Clock::get()?.unix_timestamp)
    }

    pub fn raise_dispute(ctx: Context<Act>, dispute_hash: [u8; 32]) -> Result<()> {
        let out = ctx.accounts.outcome(rules::Action::Dispute, Clock::get()?.unix_timestamp)?;
        ctx.accounts.sprint_escrow.dispute_hash = dispute_hash;
        ctx.accounts.sprint_escrow.status = out.status;
        Ok(())
    }

    pub fn resolve_dispute(ctx: Context<Act>, contractor_share_bps: u16) -> Result<()> {
        ctx.accounts.settle(rules::Action::Resolve { contractor_share_bps }, Clock::get()?.unix_timestamp)
    }
}

#[derive(Accounts)]
#[instruction(sprint_id: u64)]
pub struct InitializeSprint<'info> {
    #[account(init, payer = client, space = SprintEscrow::SPACE,
        seeds = [b"sprint", client.key().as_ref(), contractor.key().as_ref(), &sprint_id.to_le_bytes()], bump)]
    pub sprint_escrow: Account<'info, SprintEscrow>,
    #[account(mut)]
    pub client: Signer<'info>,
    /// CHECK: Public key recorded as a beneficiary; no data read. Distinctness checked in handler.
    pub contractor: UncheckedAccount<'info>,
    /// CHECK: Public key recorded as the agreed arbiter; no data read.
    pub arbiter: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// All six actions use this same wire account order. Actor must sign; recipients
// are bound to stored keys, even when the caller supplies other accounts.
#[derive(Accounts)]
pub struct Act<'info> {
    #[account(mut, seeds = [b"sprint", sprint_escrow.client.as_ref(), sprint_escrow.contractor.as_ref(),
        &sprint_escrow.sprint_id.to_le_bytes()], bump = sprint_escrow.bump,
        has_one = client, has_one = contractor, has_one = arbiter)]
    pub sprint_escrow: Account<'info, SprintEscrow>,
    pub actor: Signer<'info>,
    /// CHECK: Bound by has_one; only receives lamports.
    #[account(mut)]
    pub client: UncheckedAccount<'info>,
    /// CHECK: Bound by has_one; only receives lamports.
    #[account(mut)]
    pub contractor: UncheckedAccount<'info>,
    /// CHECK: Bound by has_one; only receives lamports.
    #[account(mut)]
    pub arbiter: UncheckedAccount<'info>,
}

impl<'info> Act<'info> {
    fn outcome(&self, action: rules::Action, now: i64) -> Result<rules::Outcome> {
        let s = &self.sprint_escrow;
        let role = if self.actor.key() == s.client { rules::Role::Client }
            else if self.actor.key() == s.contractor { rules::Role::Contractor }
            else if self.actor.key() == s.arbiter { rules::Role::Arbiter }
            else { rules::Role::Stranger };
        checked(rules::transition(s.status, role, action, s.amount_lamports,
            s.kill_fee_bps, s.arbiter_fee_bps, s.review_window_secs, s.auto_release_at, now))
    }

    fn settle(&mut self, action: rules::Action, now: i64) -> Result<()> {
        let out = self.outcome(action, now)?;
        let escrow = self.sprint_escrow.to_account_info();
        let rent = Rent::get()?.minimum_balance(escrow.data_len());
        let required = rent.checked_add(self.sprint_escrow.amount_lamports).ok_or(EscrowError::Arithmetic)?;
        require!(escrow.lamports() >= required, EscrowError::InsufficientEscrow);
        pay(&escrow, &self.contractor.to_account_info(), out.to_contractor)?;
        pay(&escrow, &self.client.to_account_info(), out.to_client)?;
        pay(&escrow, &self.arbiter.to_account_info(), out.arbiter_fee)?;
        self.sprint_escrow.status = out.status;
        Ok(())
    }
}

fn pay<'info>(from: &AccountInfo<'info>, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
    if amount == 0 { return Ok(()); }
    require_keys_neq!(from.key(), to.key(), EscrowError::DistinctParties);
    let debit = from.lamports().checked_sub(amount).ok_or(EscrowError::Arithmetic)?;
    let credit = to.lamports().checked_add(amount).ok_or(EscrowError::Arithmetic)?;
    let min_rent = Rent::get()?.minimum_balance(to.data_len());
    require!(credit >= min_rent, EscrowError::RecipientBelowRent);
    **from.try_borrow_mut_lamports()? = debit;
    **to.try_borrow_mut_lamports()? = credit;
    Ok(())
}

#[account]
pub struct SprintEscrow {
    pub client: Pubkey,
    pub contractor: Pubkey,
    pub arbiter: Pubkey,
    pub sprint_id: u64,
    pub amount_lamports: u64,
    pub kill_fee_bps: u16,
    pub arbiter_fee_bps: u16,
    pub review_window_secs: i64,
    pub created_at: i64,
    pub submitted_at: i64,
    pub auto_release_at: i64,
    pub spec_hash: [u8; 32],
    pub deliverable_hash: [u8; 32],
    pub deliverable_uri: String,
    pub dispute_hash: [u8; 32],
    pub status: u8,
    pub bump: u8,
}
impl SprintEscrow {
    pub const SPACE: usize = 8 + 96 + 16 + 4 + 32 + 64 + 4 + 128 + 32 + 2; // 386
}

fn checked<T>(result: core::result::Result<T, rules::RuleError>) -> Result<T> {
    result.map_err(|err| match err {
        rules::RuleError::Terms => error!(EscrowError::InvalidTerms),
        rules::RuleError::Access => error!(EscrowError::Unauthorized),
        rules::RuleError::State => error!(EscrowError::InvalidState),
        rules::RuleError::Uri => error!(EscrowError::UriTooLong),
        rules::RuleError::Time => error!(EscrowError::ReviewWindow),
        rules::RuleError::Share => error!(EscrowError::InvalidShare),
        rules::RuleError::Overflow => error!(EscrowError::Arithmetic),
    })
}

#[error_code]
pub enum EscrowError {
    #[msg("Invalid amount, fee basis points, or review window")]
    InvalidTerms,
    #[msg("Actor is not authorized for this instruction")]
    Unauthorized,
    #[msg("Instruction is not permitted in the current state")]
    InvalidState,
    #[msg("Deliverable URI exceeds 128 UTF-8 bytes")]
    UriTooLong,
    #[msg("Review deadline does not permit this instruction")]
    ReviewWindow,
    #[msg("Contractor share must be 0..=10000 basis points")]
    InvalidShare,
    #[msg("Arithmetic overflow or insufficient balance")]
    Arithmetic,
    #[msg("Escrow, client, contractor and arbiter must be distinct")]
    DistinctParties,
    #[msg("Escrow cannot pay principal and preserve rent")]
    InsufficientEscrow,
    #[msg("Recipient balance after payout is below rent exemption") ]
    RecipientBelowRent,
}

// BEGIN SHARED RULES -- copied verbatim by the dependency-free verifier build.rs.
pub mod rules {
    pub const FUNDED: u8 = 0;
    pub const SUBMITTED: u8 = 1;
    pub const RELEASED: u8 = 2;
    pub const AUTO_RELEASED: u8 = 3;
    pub const CANCELLED: u8 = 4;
    pub const DISPUTED: u8 = 5;
    pub const RESOLVED: u8 = 6;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Role { Client, Contractor, Arbiter, Stranger }
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Action { Submit { uri_bytes: usize }, Approve, Claim, Cancel, Dispute, Resolve { contractor_share_bps: u16 } }
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum RuleError { Terms, Access, State, Uri, Time, Share, Overflow }
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Outcome {
        pub status: u8,
        pub auto_release_at: i64,
        pub to_contractor: u64,
        pub to_client: u64,
        pub arbiter_fee: u64,
    }

    pub fn validate_terms(amount: u64, kill_bps: u16, arbiter_bps: u16, window: i64) -> Result<(), RuleError> {
        if amount == 0 || kill_bps > 5000 || arbiter_bps > 500 || !(0..=2_592_000).contains(&window) {
            return Err(RuleError::Terms);
        }
        Ok(())
    }
    pub fn portion(amount: u64, bps: u16) -> u64 {
        (u128::from(amount) * u128::from(bps) / 10_000) as u64
    }

    #[allow(clippy::too_many_arguments)]
    pub fn transition(status: u8, role: Role, action: Action, amount: u64,
        kill_bps: u16, arbiter_bps: u16, window: i64, deadline: i64, now: i64) -> Result<Outcome, RuleError> {
        validate_terms(amount, kill_bps, arbiter_bps, window)?;
        let authorized = match action {
            Action::Submit { .. } | Action::Claim => role == Role::Contractor,
            Action::Approve | Action::Cancel => role == Role::Client,
            Action::Dispute => role == Role::Client || role == Role::Contractor,
            Action::Resolve { .. } => role == Role::Arbiter,
        };
        if !authorized { return Err(RuleError::Access); }
        let valid_state = match action {
            Action::Submit { .. } | Action::Cancel => status == FUNDED,
            Action::Approve => status == FUNDED || status == SUBMITTED,
            Action::Claim | Action::Dispute => status == SUBMITTED,
            Action::Resolve { .. } => status == DISPUTED,
        };
        if !valid_state { return Err(RuleError::State); }
        let mut out = Outcome { status, auto_release_at: deadline, to_contractor: 0, to_client: 0, arbiter_fee: 0 };
        match action {
            Action::Submit { uri_bytes } => {
                if uri_bytes > 128 { return Err(RuleError::Uri); }
                out.auto_release_at = now.checked_add(window).ok_or(RuleError::Overflow)?;
                out.status = SUBMITTED;
            }
            Action::Approve => { out.status = RELEASED; out.to_contractor = amount; }
            Action::Claim => {
                if now < deadline { return Err(RuleError::Time); }
                out.status = AUTO_RELEASED;
                out.to_contractor = amount;
            }
            Action::Cancel => {
                out.status = CANCELLED;
                out.to_contractor = portion(amount, kill_bps);
                out.to_client = amount - out.to_contractor;
            }
            Action::Dispute => {
                if now >= deadline { return Err(RuleError::Time); }
                out.status = DISPUTED;
            }
            Action::Resolve { contractor_share_bps } => {
                if contractor_share_bps > 10_000 { return Err(RuleError::Share); }
                out.status = RESOLVED;
                out.arbiter_fee = portion(amount, arbiter_bps);
                let distributable = amount - out.arbiter_fee;
                out.to_contractor = portion(distributable, contractor_share_bps);
                out.to_client = distributable - out.to_contractor;
            }
        }
        Ok(out)
    }
}
// END SHARED RULES

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allocated_space_matches_max_serialization() {
        let s = SprintEscrow {
            client: Pubkey::new_unique(), contractor: Pubkey::new_unique(), arbiter: Pubkey::new_unique(),
            sprint_id: u64::MAX, amount_lamports: u64::MAX, kill_fee_bps: 5000, arbiter_fee_bps: 500,
            review_window_secs: 2_592_000, created_at: 0, submitted_at: 0, auto_release_at: 0,
            spec_hash: [1; 32], deliverable_hash: [2; 32], deliverable_uri: "a".repeat(128),
            dispute_hash: [3; 32], status: 0, bump: 255,
        };
        let mut bytes = Vec::new();
        s.try_serialize(&mut bytes).unwrap();
        assert_eq!(bytes.len(), SprintEscrow::SPACE);
    }
    #[test]
    fn native_conservation_at_max_amount() {
        for share in 0..=10_000 {
            let o = rules::transition(5, rules::Role::Arbiter, rules::Action::Resolve { contractor_share_bps: share },
                u64::MAX, 5000, 500, 1, 1, 1).unwrap();
            assert_eq!(u128::from(o.to_client) + u128::from(o.to_contractor) + u128::from(o.arbiter_fee), u128::from(u64::MAX));
        }
    }
}
