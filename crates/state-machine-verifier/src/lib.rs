//! Uses the program's actual rules, with no Anchor dependency or network needed.
include!(concat!(env!("OUT_DIR"), "/rules.rs"));

#[cfg(test)]
mod tests;

#[cfg(test)]
mod payment_boundaries {
    use std::cell::{RefCell, RefMut};
    use std::marker::PhantomData;
    #[derive(Debug, PartialEq)]
    enum EscrowError { Arithmetic, DistinctParties, RecipientBelowRent }
    type Result<T> = std::result::Result<T, EscrowError>;
    struct AccountInfo<'a> { key: u8, balance: RefCell<Box<u64>>, len: usize, marker: PhantomData<&'a ()> }
    impl AccountInfo<'_> {
        fn new(key: u8, balance: u64, len: usize) -> Self { Self { key, balance: RefCell::new(Box::new(balance)), len, marker: PhantomData } }
        fn key(&self) -> u8 { self.key }
        fn lamports(&self) -> u64 { **self.balance.borrow() }
        fn data_len(&self) -> usize { self.len }
        fn try_borrow_mut_lamports(&self) -> Result<RefMut<'_, Box<u64>>> { Ok(self.balance.borrow_mut()) }
    }
    // Synthetic rent schedule; the extracted body must use each recipient's data length.
    struct Rent;
    impl Rent {
        fn get() -> Result<Self> { Ok(Self) }
        fn minimum_balance(&self, len: usize) -> u64 { 100 + len as u64 * 10 }
    }
    macro_rules! require { ($ok:expr, $err:expr) => { if !$ok { return Err($err); } }; }
    macro_rules! require_keys_neq { ($a:expr, $b:expr, $err:expr) => { require!($a != $b, $err); }; }
    include!(concat!(env!("OUT_DIR"), "/boundaries.rs"));
    #[test]
    fn all_four_addresses_must_differ() {
        assert!(distinct(1,2,3,4));
        for i in 0..4 { for j in i+1..4 {
            let mut keys=[1,2,3,4]; keys[j]=keys[i];
            assert!(!distinct(keys[0],keys[1],keys[2],keys[3]));
        }}
    }
    #[test]
    fn recipient_rent_boundaries_and_no_partial_debit() {
        for len in [0, 8, 386] {
            let rent=Rent.minimum_balance(len);
            for credit in [rent-1,rent,rent+1] {
                let from=AccountInfo::new(1,10000,386);
                let to=AccountInfo::new(2,credit-1,len);
                let result=pay(&from,&to,1);
                if credit<rent {
                    assert_eq!(result,Err(EscrowError::RecipientBelowRent));
                    assert_eq!(from.lamports(),10000); assert_eq!(to.lamports(),credit-1);
                } else { assert_eq!(result,Ok(())); assert_eq!(from.lamports(),9999); assert_eq!(to.lamports(),credit); }
            }
        }
        let from=AccountInfo::new(1,10000,0);
        let empty=AccountInfo::new(2,0,0);
        assert_eq!(pay(&from,&empty,0),Ok(()));
        assert_eq!(pay(&from,&empty,1),Err(EscrowError::RecipientBelowRent));
        assert_eq!(pay(&from,&from,1),Err(EscrowError::DistinctParties));
        let full=AccountInfo::new(2,u64::MAX,0);
        assert_eq!(pay(&from,&full,1),Err(EscrowError::Arithmetic));
        assert_eq!(from.lamports(),10000);
    }
}
