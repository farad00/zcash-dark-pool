//! Compile-only Spike G compatibility probe; never constructs or exports keys.
//! The constructor is the one used by official frost-tools revision
//! 06c0dbdbb1bac9b99cd255e74ba2f387c295e660 (zcash-sign/src/generate.rs).
//! Published Orchard 0.15.5 is expected to reject this unpublished API.

use orchard::keys::{FullViewingKey, SpendValidatingKey, SpendingKey};

fn frost_tools_constructor(sk: &SpendingKey, ak: &SpendValidatingKey) -> FullViewingKey {
    FullViewingKey::from_sk_ak_incompatible_with_quantum_recoverability_and_will_be_removed(
        sk,
        ak.clone(),
    )
}

fn main() {}
