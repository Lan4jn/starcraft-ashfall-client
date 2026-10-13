#[test]
fn capability_is_exact_not_port_wildcard() {
    let cap = ashfall_desktop::capability_json("http://127.0.0.1:31001");
    assert_eq!(cap["remote"]["urls"][0], "http://127.0.0.1:31001/*");
    assert_eq!(cap["windows"][0], "main");
    assert_eq!(cap["local"], false);
    assert!(!cap.to_string().contains("127.0.0.1:*"));
}
