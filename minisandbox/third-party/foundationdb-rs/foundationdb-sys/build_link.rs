use std::env;

pub const LINK_ENVIRONMENT: &[&str] = &[
    "FDB_CLIENT_LIB_PATH",
    "FDB_CLIENT_LINK_KIND",
    "FDB_CLIENT_STATIC_LIBS",
    "FDB_CLIENT_SYSTEM_LIBS",
];

pub fn directives_from_environment() -> Result<Vec<String>, String> {
    directives(
        env::var("FDB_CLIENT_LINK_KIND").ok().as_deref(),
        env::var("FDB_CLIENT_STATIC_LIBS").ok().as_deref(),
        env::var("FDB_CLIENT_SYSTEM_LIBS").ok().as_deref(),
    )
}

fn parse_list(name: &str, value: Option<&str>, required: bool) -> Result<Vec<String>, String> {
    let Some(value) = value else {
        return if required {
            Err(format!("{name} is required for static linkage"))
        } else {
            Ok(Vec::new())
        };
    };

    let mut values = Vec::new();
    for item in value.split(',') {
        let item = item.trim();
        if item.is_empty()
            || !item
                .as_bytes()
                .first()
                .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
            || !item
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'+'))
        {
            return Err(format!("{name} contains an invalid library name"));
        }
        values.push(item.to_owned());
    }
    Ok(values)
}

pub fn directives(
    link_kind: Option<&str>,
    static_libraries: Option<&str>,
    system_libraries: Option<&str>,
) -> Result<Vec<String>, String> {
    match link_kind.unwrap_or("dynamic") {
        "dynamic" => {
            if static_libraries.is_some() || system_libraries.is_some() {
                return Err("static dependency lists require FDB_CLIENT_LINK_KIND=static".into());
            }
            Ok(vec!["rustc-link-lib=fdb_c".into()])
        }
        "static" => {
            let mut directives = vec!["rustc-link-lib=static=fdb_c".into()];
            directives.extend(
                parse_list("FDB_CLIENT_STATIC_LIBS", static_libraries, true)?
                    .into_iter()
                    .map(|library| format!("rustc-link-lib=static={library}")),
            );
            directives.extend(
                parse_list("FDB_CLIENT_SYSTEM_LIBS", system_libraries, false)?
                    .into_iter()
                    .map(|library| format!("rustc-link-lib={library}")),
            );
            Ok(directives)
        }
        other => Err(format!(
            "FDB_CLIENT_LINK_KIND must be dynamic or static, got {other:?}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{directives, LINK_ENVIRONMENT};

    #[test]
    fn library_path_is_a_cargo_fingerprint_input() {
        assert!(LINK_ENVIRONMENT.contains(&"FDB_CLIENT_LIB_PATH"));
    }

    #[test]
    fn dynamic_is_backward_compatible() {
        assert_eq!(
            directives(None, None, None).unwrap(),
            ["rustc-link-lib=fdb_c"]
        );
    }

    #[test]
    fn static_requires_an_explicit_transitive_graph() {
        assert!(directives(Some("static"), None, None).is_err());
    }

    #[test]
    fn static_preserves_archive_order_and_separates_system_libraries() {
        assert_eq!(
            directives(
                Some("static"),
                Some("fdbclient,flow,ssl,crypto,z"),
                Some("c++,c++abi,unwind,rt,pthread,dl")
            )
            .unwrap(),
            [
                "rustc-link-lib=static=fdb_c",
                "rustc-link-lib=static=fdbclient",
                "rustc-link-lib=static=flow",
                "rustc-link-lib=static=ssl",
                "rustc-link-lib=static=crypto",
                "rustc-link-lib=static=z",
                "rustc-link-lib=c++",
                "rustc-link-lib=c++abi",
                "rustc-link-lib=unwind",
                "rustc-link-lib=rt",
                "rustc-link-lib=pthread",
                "rustc-link-lib=dl",
            ]
        );
    }

    #[test]
    fn rejects_linker_argument_injection() {
        assert!(directives(Some("static"), Some("flow,-Wl,--whole-archive"), None).is_err());
        assert!(directives(Some("dynamic"), Some("flow"), None).is_err());
    }
}
