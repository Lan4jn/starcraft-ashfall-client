use ashfall_client_core::save::SaveSnapshot;
use std::collections::BTreeMap;

#[test]
fn origin_authorization_rejects_other_ports_and_windows() {
    use ashfall_desktop::commands::authorized_source;
    let origin = "http://127.0.0.1:31001";
    assert!(authorized_source(
        "main",
        "http://127.0.0.1:31001/index.html",
        origin
    ));
    assert!(!authorized_source(
        "other",
        "http://127.0.0.1:31001/index.html",
        origin
    ));
    assert!(!authorized_source(
        "main",
        "http://127.0.0.1:31002/index.html",
        origin
    ));
    assert!(!authorized_source(
        "main",
        "http://127.0.0.1:31001.evil.test/",
        origin
    ));
    assert!(!authorized_source("main", "https://example.org/", origin));
}

#[test]
fn initialization_is_origin_scoped_and_escapes_seed() {
    let seed = SaveSnapshot {
        schema_version: 1,
        revision: 7,
        saved_at: "2026-10-12T00:00:00Z".into(),
        values: BTreeMap::from([("key".into(), "</script>\u{2028}危险".into())]),
    };
    let js = ashfall_desktop::initialization::build_script(
        "http://127.0.0.1:31001",
        Some(&seed),
        "unit-session",
    )
    .unwrap();
    assert!(js.contains("http://127.0.0.1:31001"));
    assert!(!js.contains("</script>"));
    assert!(!js.contains('\u{2028}'));
    assert!(!js.contains("export function"));
    assert!(js.contains("location.origin"));
    assert!(js.contains("sessionStorage"));
}

#[test]
fn seed_uses_json_parse_to_preserve_proto_data_key() {
    let seed = SaveSnapshot {
        schema_version: 1,
        revision: 1,
        saved_at: "2026-10-12T00:00:00Z".into(),
        values: BTreeMap::from([("__proto__".into(), "原型键".into())]),
    };
    let js = ashfall_desktop::initialization::build_script(
        "http://127.0.0.1:31001",
        Some(&seed),
        "proto-session",
    )
    .unwrap();
    assert!(
        js.contains("let seed = JSON.parse("),
        "嵌入JSON对象字面量会吞掉__proto__键，应解析JSON字符串"
    );
}
