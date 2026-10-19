use std::{env, fs, path::PathBuf};
fn main() {
    let source = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../programs/clear-milestone/src/lib.rs");
    println!("cargo:rerun-if-changed={}", source.display());
    let text = fs::read_to_string(source).unwrap();
    let begin = text.find("pub mod rules {").expect("shared rules start");
    let end = text.find("// END SHARED RULES").expect("shared rules end");
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("rules.rs"), &text[begin..end]).unwrap();
    // Compile the actual payment body and initialization predicate against tiny host stubs.
    let pay = text.split("fn pay<'info>").nth(1).unwrap().split("#[account]").next().unwrap();
    let predicate = text.split("require!(client != contractor").nth(1).unwrap().split(", EscrowError::DistinctParties)").next().unwrap();
    let boundary = format!("fn pay<'info>{pay}\npub fn distinct(client: u8, contractor: u8, arbiter: u8, escrow: u8) -> bool {{ client != contractor{predicate} }}");
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("boundaries.rs"), boundary).unwrap();
}
