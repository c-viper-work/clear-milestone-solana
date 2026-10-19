use crate::rules::*;

fn step(status: u8, role: Role, action: Action, now: i64) -> Result<Outcome, RuleError> {
    transition(status, role, action, 1_000_003, 2500, 300, 60, 160, now)
}

#[test]
fn initialize_and_all_six_actions() {
    assert_eq!(validate_terms(1_000_003, 2500, 300, 60), Ok(()));
    let submitted = step(FUNDED, Role::Contractor, Action::Submit { uri_bytes: 128 }, 100).unwrap();
    assert_eq!((submitted.status, submitted.auto_release_at), (SUBMITTED, 160));
    assert_eq!(submitted.to_client + submitted.to_contractor + submitted.arbiter_fee, 0);
    for state in [FUNDED, SUBMITTED] {
        let o = step(state, Role::Client, Action::Approve, 100).unwrap();
        assert_eq!((o.status, o.to_contractor), (RELEASED, 1_000_003));
    }
    let claimed = step(submitted.status, Role::Contractor, Action::Claim, 160).unwrap();
    assert_eq!((claimed.status, claimed.to_contractor), (AUTO_RELEASED, 1_000_003));
    let cancelled = step(FUNDED, Role::Client, Action::Cancel, 100).unwrap();
    assert_eq!((cancelled.status, cancelled.to_contractor, cancelled.to_client), (CANCELLED, 250_000, 750_003));
    for role in [Role::Client, Role::Contractor] {
        let disputed = step(SUBMITTED, role, Action::Dispute, 159).unwrap();
        assert_eq!(disputed.status, DISPUTED);
        let o = step(disputed.status, Role::Arbiter, Action::Resolve { contractor_share_bps: 7500 }, 999).unwrap();
        assert_eq!((o.status, o.arbiter_fee, o.to_contractor, o.to_client), (RESOLVED, 30_000, 727_502, 242_501));
    }
}

#[test]
fn terms_boundaries() {
    for amount in [1, u64::MAX] {
        for kill in [0, 5000] {
            for fee in [0, 500] {
                for window in [0, 2_592_000] {
                    assert_eq!(validate_terms(amount, kill, fee, window), Ok(()));
                }
            }
        }
    }
    for terms in [(0, 0, 0, 0), (1, 5001, 0, 0), (1, u16::MAX, 0, 0),
        (1, 0, 501, 0), (1, 0, u16::MAX, 0), (1, 0, 0, -1), (1, 0, 0, 2_592_001)] {
        assert_eq!(validate_terms(terms.0, terms.1, terms.2, terms.3), Err(RuleError::Terms));
    }
}

#[test]
fn exact_deadline_is_claimable_but_not_disputable() {
    assert_eq!(step(SUBMITTED, Role::Contractor, Action::Claim, 159), Err(RuleError::Time));
    for now in [160, 161, i64::MAX] {
        assert!(step(SUBMITTED, Role::Contractor, Action::Claim, now).is_ok());
        assert_eq!(step(SUBMITTED, Role::Client, Action::Dispute, now), Err(RuleError::Time));
    }
    assert!(step(SUBMITTED, Role::Client, Action::Dispute, 159).is_ok());
}

#[test]
fn zero_window_and_checked_timestamp() {
    let o = transition(FUNDED, Role::Contractor, Action::Submit { uri_bytes: 0 }, 1, 0, 0, 0, 0, 42).unwrap();
    assert_eq!(o.auto_release_at, 42);
    assert!(transition(SUBMITTED, Role::Contractor, Action::Claim, 1, 0, 0, 0, 42, 42).is_ok());
    assert_eq!(transition(SUBMITTED, Role::Client, Action::Dispute, 1, 0, 0, 0, 42, 42), Err(RuleError::Time));
    assert_eq!(transition(FUNDED, Role::Contractor, Action::Submit { uri_bytes: 0 }, 1, 0, 0, 1, 0, i64::MAX), Err(RuleError::Overflow));
}

#[test]
fn uri_is_measured_in_bytes_and_share_is_bounded() {
    for uri in [String::new(), "a".repeat(128), "ą".repeat(64)] {
        assert!(step(FUNDED, Role::Contractor, Action::Submit { uri_bytes: uri.len() }, 100).is_ok());
    }
    for uri in ["a".repeat(129), "ą".repeat(65)] {
        assert_eq!(step(FUNDED, Role::Contractor, Action::Submit { uri_bytes: uri.len() }, 100), Err(RuleError::Uri));
    }
    for share in [10_001, u16::MAX] {
        assert_eq!(step(DISPUTED, Role::Arbiter, Action::Resolve { contractor_share_bps: share }, 100), Err(RuleError::Share));
    }
}

#[test]
fn complete_role_and_state_matrix() {
    let actions = [Action::Submit { uri_bytes: 1 }, Action::Approve, Action::Claim,
        Action::Cancel, Action::Dispute, Action::Resolve { contractor_share_bps: 5000 }];
    // Independent explicit allow-list of (action index, role, permitted states).
    let allowed = [(0, Role::Contractor, vec![0]), (1, Role::Client, vec![0, 1]),
        (2, Role::Contractor, vec![1]), (3, Role::Client, vec![0]),
        (4, Role::Client, vec![1]), (4, Role::Contractor, vec![1]), (5, Role::Arbiter, vec![5])];
    for (index, action) in actions.iter().enumerate() {
        for role in [Role::Client, Role::Contractor, Role::Arbiter, Role::Stranger] {
            for state in 0..=7 {
                let expected = allowed.iter().any(|(i, r, states)| *i == index && *r == role && states.contains(&state));
                let now = if index == 2 { 160 } else { 159 };
                assert_eq!(step(state, role, *action, now).is_ok(), expected, "action={action:?}, role={role:?}, state={state}");
            }
        }
    }
}

#[test]
fn final_states_never_pay_twice_and_dispute_freezes_release() {
    for (state, role, action, now) in [
        (FUNDED, Role::Client, Action::Approve, 100),
        (SUBMITTED, Role::Contractor, Action::Claim, 160),
        (FUNDED, Role::Client, Action::Cancel, 100),
        (DISPUTED, Role::Arbiter, Action::Resolve { contractor_share_bps: 5000 }, 100),
    ] {
        let out = step(state, role, action, now).unwrap();
        assert_eq!(step(out.status, role, action, now), Err(RuleError::State));
    }
    assert_eq!(step(DISPUTED, Role::Client, Action::Approve, 999), Err(RuleError::State));
    assert_eq!(step(DISPUTED, Role::Contractor, Action::Claim, 999), Err(RuleError::State));
}

#[test]
fn conservation_for_every_kill_fee_basis_point() {
    for amount in [1, 9_999, 10_000, 1_000_003, u64::MAX] {
        for kill in 0..=5000 {
            let o = transition(FUNDED, Role::Client, Action::Cancel, amount, kill, 0, 0, 0, 0).unwrap();
            assert_eq!(u128::from(o.to_client) + u128::from(o.to_contractor), u128::from(amount));
            assert_eq!(o.arbiter_fee, 0);
            assert!(o.to_contractor <= amount / 2);
        }
    }
}

#[test]
fn conservation_for_every_share_and_every_arbiter_fee() {
    // Exhaustive cross-product: 10,001 shares x 501 fees x 5 representative amounts.
    for amount in [1, 9_999, 10_000, 1_000_003, u64::MAX] {
        for fee in 0..=500 {
            for share in 0..=10_000 {
                let o = transition(DISPUTED, Role::Arbiter, Action::Resolve { contractor_share_bps: share }, amount, 0, fee, 0, 0, 0).unwrap();
                assert_eq!(u128::from(o.to_contractor) + u128::from(o.to_client) + u128::from(o.arbiter_fee), u128::from(amount));
                assert!(o.arbiter_fee <= amount / 20);
                if share == 0 { assert_eq!(o.to_contractor, 0); }
                if share == 10_000 { assert_eq!(o.to_client, 0); }
            }
        }
    }
}
