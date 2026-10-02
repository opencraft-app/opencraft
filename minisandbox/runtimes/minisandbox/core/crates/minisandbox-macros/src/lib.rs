#![forbid(unsafe_code)]

//! Procedural macros for minisandbox's declarative contracts.

use proc_macro::TokenStream;
use quote::quote;
use syn::{ItemEnum, Path, Token, parse_macro_input, punctuated::Punctuated};

/// Generates a representation-stable enum with the common contract traits.
#[proc_macro]
pub fn contract_enum(input: TokenStream) -> TokenStream {
    let item = parse_macro_input!(input as ItemEnum);
    if !has_integer_repr(&item) {
        return syn::Error::new_spanned(
            &item.ident,
            "contract_enum requires an integer #[repr(...)]",
        )
        .into_compile_error()
        .into();
    }
    quote! {
        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        #item
    }
    .into()
}

fn has_integer_repr(item: &ItemEnum) -> bool {
    item.attrs.iter().any(|attribute| {
        attribute.path().is_ident("repr")
            && attribute
                .parse_args_with(Punctuated::<Path, Token![,]>::parse_terminated)
                .is_ok_and(|representations| {
                    representations.iter().any(|representation| {
                        representation.is_ident("u8")
                            || representation.is_ident("u16")
                            || representation.is_ident("u32")
                            || representation.is_ident("u64")
                            || representation.is_ident("i8")
                            || representation.is_ident("i16")
                            || representation.is_ident("i32")
                            || representation.is_ident("i64")
                    })
                })
    })
}
