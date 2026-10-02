//! Compile-time validation tests for contract macros.

#[test]
fn contract_enum_rejects_a_missing_integer_repr() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/missing_repr.rs");
}
