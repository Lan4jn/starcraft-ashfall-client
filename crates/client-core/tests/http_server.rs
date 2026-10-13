use std::fs;
use std::time::Duration;
use tempfile::tempdir;

use ashfall_client_core::http_server::{DEFAULT_CSP, start};

async fn send_raw_http(port: u16, raw_request: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(format!("127.0.0.1:{}", port))
        .await
        .unwrap();
    stream.write_all(raw_request.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    let _ = stream.read_to_end(&mut buf).await;
    String::from_utf8_lossy(&buf).to_string()
}

#[tokio::test]
async fn test_server_bootstrap_flow_and_cookie_auth() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("index.html"), "Hello World").unwrap();
    fs::create_dir_all(root.join("assets")).unwrap();
    fs::write(root.join("assets/main.js"), "console.log('ok');").unwrap();

    let handle = start(root.to_path_buf()).await.expect("server must start");
    let origin = handle.origin.clone();
    let bootstrap_url = handle.bootstrap_url.clone();

    // 1. Client without cookie accessing /index.html directly must be rejected with 403
    let raw_client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();

    let res = raw_client
        .get(format!("{}/index.html", origin))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::FORBIDDEN);

    // 2. Client consuming bootstrap URL
    let res = raw_client.get(&bootstrap_url).send().await.unwrap();

    assert_eq!(res.status(), reqwest::StatusCode::SEE_OTHER);
    let location = res
        .headers()
        .get(reqwest::header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap();
    assert_eq!(location, "/index.html");
    assert_eq!(
        res.headers()
            .get(reqwest::header::CACHE_CONTROL)
            .unwrap()
            .to_str()
            .unwrap(),
        "no-store, private"
    );
    assert_eq!(
        res.headers()
            .get("referrer-policy")
            .unwrap()
            .to_str()
            .unwrap(),
        "no-referrer"
    );

    // Verify Set-Cookie header attributes
    let set_cookie = res
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(set_cookie.contains("HttpOnly"), "cookie must be HttpOnly");
    assert!(
        set_cookie.contains("SameSite=Strict"),
        "cookie must be SameSite=Strict"
    );
    assert!(set_cookie.contains("Path=/"), "cookie path must be /");
    assert!(
        !set_cookie.contains("Secure"),
        "HTTP server must not set Secure flag"
    );

    let cookie_val = set_cookie.split(';').next().unwrap().trim();

    // 3. Replay bootstrap URL must return 403 Forbidden
    let replay_res = raw_client.get(&bootstrap_url).send().await.unwrap();
    assert_eq!(replay_res.status(), reqwest::StatusCode::FORBIDDEN);

    // 4. Request with valid cookie succeeds
    let auth_res = raw_client
        .get(format!("{}/index.html", origin))
        .header(reqwest::header::COOKIE, cookie_val)
        .send()
        .await
        .unwrap();
    assert_eq!(auth_res.status(), reqwest::StatusCode::OK);
    assert_eq!(
        auth_res
            .headers()
            .get(reqwest::header::CACHE_CONTROL)
            .unwrap()
            .to_str()
            .unwrap(),
        "no-store, private"
    );
    assert_eq!(
        auth_res
            .headers()
            .get("referrer-policy")
            .unwrap()
            .to_str()
            .unwrap(),
        "no-referrer"
    );
    let text = auth_res.text().await.unwrap();
    assert_eq!(text, "Hello World");

    // 5. Access sub-resource with cookie
    let asset_res = raw_client
        .get(format!("{}/assets/main.js", origin))
        .header(reqwest::header::COOKIE, cookie_val)
        .send()
        .await
        .unwrap();
    assert_eq!(asset_res.status(), reqwest::StatusCode::OK);
    assert_eq!(asset_res.text().await.unwrap(), "console.log('ok');");

    // 6. Request with invalid/forged cookie returns 403
    let forged_res = raw_client
        .get(format!("{}/index.html", origin))
        .header(
            reqwest::header::COOKIE,
            "ashfall_session=forgedtokenvalue12345",
        )
        .send()
        .await
        .unwrap();
    assert_eq!(forged_res.status(), reqwest::StatusCode::FORBIDDEN);

    handle.shutdown().await.expect("shutdown should succeed");
}

#[tokio::test]
async fn test_host_and_origin_headers() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("index.html"), "Hello").unwrap();

    let handle = start(root.to_path_buf()).await.unwrap();
    let origin = handle.origin.clone();
    let bootstrap_url = handle.bootstrap_url.clone();

    // Get cookie
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let boot_res = client.get(&bootstrap_url).send().await.unwrap();
    let cookie_val = boot_res
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();

    // 1. Correct Host and Origin works
    let port = origin.strip_prefix("http://127.0.0.1:").unwrap();
    let res = client
        .get(format!("{}/index.html", origin))
        .header(reqwest::header::COOKIE, &cookie_val)
        .header(reqwest::header::HOST, format!("127.0.0.1:{}", port))
        .header(
            reqwest::header::ORIGIN,
            format!("http://127.0.0.1:{}", port),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::OK);

    // 2. Mismatched Host returns 400 Bad Request
    let res = client
        .get(format!("{}/index.html", origin))
        .header(reqwest::header::COOKIE, &cookie_val)
        .header(reqwest::header::HOST, "localhost:8080")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::BAD_REQUEST);

    // 3. Mismatched Origin returns 403 Forbidden
    let res = client
        .get(format!("{}/index.html", origin))
        .header(reqwest::header::COOKIE, &cookie_val)
        .header(reqwest::header::ORIGIN, "http://malicious.com")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::FORBIDDEN);

    // 4. Sec-Fetch-Site cross-site returns 403 Forbidden
    let res = client
        .get(format!("{}/index.html", origin))
        .header(reqwest::header::COOKIE, &cookie_val)
        .header("sec-fetch-site", "cross-site")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::FORBIDDEN);

    // 5. Sec-Fetch-Site same-origin succeeds
    let res = client
        .get(format!("{}/index.html", origin))
        .header(reqwest::header::COOKIE, &cookie_val)
        .header("sec-fetch-site", "same-origin")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::OK);

    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn test_http_methods_and_status_codes() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("index.html"), "Home").unwrap();

    let handle = start(root.to_path_buf()).await.unwrap();
    let origin = handle.origin.clone();
    let bootstrap_url = handle.bootstrap_url.clone();

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let boot_res = client.get(&bootstrap_url).send().await.unwrap();
    let cookie_val = boot_res
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();

    // 1. Non-GET/HEAD methods return 405 Method Not Allowed
    let post_res = client
        .post(format!("{}/index.html", origin))
        .header(reqwest::header::COOKIE, &cookie_val)
        .send()
        .await
        .unwrap();
    assert_eq!(post_res.status(), reqwest::StatusCode::METHOD_NOT_ALLOWED);

    let put_res = client
        .put(format!("{}/index.html", origin))
        .header(reqwest::header::COOKIE, &cookie_val)
        .send()
        .await
        .unwrap();
    assert_eq!(put_res.status(), reqwest::StatusCode::METHOD_NOT_ALLOWED);

    // 2. Unknown file returns 404 and does NOT return HTML
    let not_found_res = client
        .get(format!("{}/non_existent_file.js", origin))
        .header(reqwest::header::COOKIE, &cookie_val)
        .send()
        .await
        .unwrap();
    assert_eq!(not_found_res.status(), reqwest::StatusCode::NOT_FOUND);
    let body = not_found_res.text().await.unwrap();
    assert!(
        !body.contains("<html") && !body.contains("<!DOCTYPE"),
        "404 must not return HTML"
    );

    // 3. Query parameters stripped via uri.path()
    let query_res = client
        .get(format!("{}/index.html?v=1.2.3&build=456", origin))
        .header(reqwest::header::COOKIE, &cookie_val)
        .send()
        .await
        .unwrap();
    assert_eq!(query_res.status(), reqwest::StatusCode::OK);
    assert_eq!(query_res.text().await.unwrap(), "Home");

    // 4a. Client URL normalization of /../Cargo.toml results in /Cargo.toml which is 404 in tempdir (no file leakage)
    let trav_res = client
        .get(format!("{}/../Cargo.toml", origin))
        .header(reqwest::header::COOKIE, &cookie_val)
        .send()
        .await
        .unwrap();
    assert_eq!(trav_res.status(), reqwest::StatusCode::NOT_FOUND);

    // 4b. Raw TCP request with encoded traversal /%2e%2e/Cargo.toml (bypasses client normalization)
    let port_str = origin.strip_prefix("http://127.0.0.1:").unwrap();
    let port_num: u16 = port_str.parse().unwrap();
    let raw_req_encoded = format!(
        "GET /%2e%2e/Cargo.toml HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nCookie: {}\r\nConnection: close\r\n\r\n",
        port_num, cookie_val
    );
    let raw_resp_encoded = send_raw_http(port_num, &raw_req_encoded).await;
    assert!(
        raw_resp_encoded.starts_with("HTTP/1.1 400 Bad Request"),
        "Encoded traversal /%2e%2e/Cargo.toml must return 400 Bad Request, got: {}",
        raw_resp_encoded
    );

    // 4c. Raw TCP request with literal traversal /../Cargo.toml
    let raw_req_literal = format!(
        "GET /../Cargo.toml HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nCookie: {}\r\nConnection: close\r\n\r\n",
        port_num, cookie_val
    );
    let raw_resp_literal = send_raw_http(port_num, &raw_req_literal).await;
    assert!(
        raw_resp_literal.starts_with("HTTP/1.1 400 Bad Request"),
        "Literal traversal /../Cargo.toml must return 400 Bad Request, got: {}",
        raw_resp_literal
    );

    // 4d. Raw TCP request with double-encoded traversal /%252e%252e/Cargo.toml
    let raw_req_double = format!(
        "GET /%252e%252e/Cargo.toml HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nCookie: {}\r\nConnection: close\r\n\r\n",
        port_num, cookie_val
    );
    let raw_resp_double = send_raw_http(port_num, &raw_req_double).await;
    assert!(
        raw_resp_double.starts_with("HTTP/1.1 400 Bad Request"),
        "Double encoded traversal /%252e%252e/Cargo.toml must return 400 Bad Request, got: {}",
        raw_resp_double
    );

    // 5. CSP header present
    let csp_res = client
        .get(format!("{}/index.html", origin))
        .header(reqwest::header::COOKIE, &cookie_val)
        .send()
        .await
        .unwrap();
    let csp_header = csp_res.headers().get("content-security-policy");
    assert!(csp_header.is_some(), "CSP header must be present");
    assert_eq!(csp_header.unwrap().to_str().unwrap(), DEFAULT_CSP);

    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn test_head_method() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let content = "HEAD method test content";
    fs::write(root.join("index.html"), content).unwrap();

    let handle = start(root.to_path_buf()).await.unwrap();
    let origin = handle.origin.clone();
    let bootstrap_url = handle.bootstrap_url.clone();

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let boot_res = client.get(&bootstrap_url).send().await.unwrap();
    let cookie_val = boot_res
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();

    let head_res = client
        .head(format!("{}/index.html", origin))
        .header(reqwest::header::COOKIE, &cookie_val)
        .send()
        .await
        .unwrap();

    assert_eq!(head_res.status(), reqwest::StatusCode::OK);
    assert_eq!(
        head_res
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .unwrap()
            .to_str()
            .unwrap(),
        content.len().to_string()
    );
    assert_eq!(
        head_res
            .headers()
            .get(reqwest::header::ACCEPT_RANGES)
            .unwrap()
            .to_str()
            .unwrap(),
        "bytes"
    );
    let bytes = head_res.bytes().await.unwrap();
    assert!(bytes.is_empty(), "HEAD response body must be empty");

    // HEAD on non-existent resource returns 404 with empty body
    let head_404 = client
        .head(format!("{}/non_existent_file.js", origin))
        .header(reqwest::header::COOKIE, &cookie_val)
        .send()
        .await
        .unwrap();
    assert_eq!(head_404.status(), reqwest::StatusCode::NOT_FOUND);
    assert!(
        head_404.bytes().await.unwrap().is_empty(),
        "HEAD 404 response body must be empty"
    );

    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn test_range_requests() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let data = b"0123456789";
    fs::write(root.join("data.bin"), data).unwrap();

    let handle = start(root.to_path_buf()).await.unwrap();
    let origin = handle.origin.clone();
    let bootstrap_url = handle.bootstrap_url.clone();

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let boot_res = client.get(&bootstrap_url).send().await.unwrap();
    let cookie_val = boot_res
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();

    // 1. Closed range: bytes=1-4
    let res = client
        .get(format!("{}/data.bin", origin))
        .header(reqwest::header::COOKIE, &cookie_val)
        .header(reqwest::header::RANGE, "bytes=1-4")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        res.headers()
            .get(reqwest::header::CONTENT_RANGE)
            .unwrap()
            .to_str()
            .unwrap(),
        "bytes 1-4/10"
    );
    assert_eq!(
        res.headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .unwrap()
            .to_str()
            .unwrap(),
        "4"
    );
    assert_eq!(res.bytes().await.unwrap(), &data[1..=4]);

    // 2. Open range: bytes=6-
    let res = client
        .get(format!("{}/data.bin", origin))
        .header(reqwest::header::COOKIE, &cookie_val)
        .header(reqwest::header::RANGE, "bytes=6-")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        res.headers()
            .get(reqwest::header::CONTENT_RANGE)
            .unwrap()
            .to_str()
            .unwrap(),
        "bytes 6-9/10"
    );
    assert_eq!(
        res.headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .unwrap()
            .to_str()
            .unwrap(),
        "4"
    );
    assert_eq!(res.bytes().await.unwrap(), &data[6..=9]);

    // 3. Suffix range: bytes=-3
    let res = client
        .get(format!("{}/data.bin", origin))
        .header(reqwest::header::COOKIE, &cookie_val)
        .header(reqwest::header::RANGE, "bytes=-3")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        res.headers()
            .get(reqwest::header::CONTENT_RANGE)
            .unwrap()
            .to_str()
            .unwrap(),
        "bytes 7-9/10"
    );
    assert_eq!(
        res.headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .unwrap()
            .to_str()
            .unwrap(),
        "3"
    );
    assert_eq!(res.bytes().await.unwrap(), &data[7..=9]);

    // 4. Unsatisfiable range: bytes=20-30 -> 416
    let res = client
        .get(format!("{}/data.bin", origin))
        .header(reqwest::header::COOKIE, &cookie_val)
        .header(reqwest::header::RANGE, "bytes=20-30")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(
        res.headers()
            .get(reqwest::header::CONTENT_RANGE)
            .unwrap()
            .to_str()
            .unwrap(),
        "bytes */10"
    );
    assert!(res.bytes().await.unwrap().is_empty());

    // 5. Multiple ranges: bytes=0-1,2-3 -> 400
    let res = client
        .get(format!("{}/data.bin", origin))
        .header(reqwest::header::COOKIE, &cookie_val)
        .header(reqwest::header::RANGE, "bytes=0-1,2-3")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::BAD_REQUEST);

    // 6. Malformed range: bytes=xyz -> 400
    let res = client
        .get(format!("{}/data.bin", origin))
        .header(reqwest::header::COOKIE, &cookie_val)
        .header(reqwest::header::RANGE, "bytes=xyz")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::BAD_REQUEST);

    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn test_empty_file() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("empty.txt"), b"").unwrap();

    let handle = start(root.to_path_buf()).await.unwrap();
    let origin = handle.origin.clone();
    let bootstrap_url = handle.bootstrap_url.clone();

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let boot_res = client.get(&bootstrap_url).send().await.unwrap();
    let cookie_val = boot_res
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();

    // Empty file without range returns 200, length 0
    let res = client
        .get(format!("{}/empty.txt", origin))
        .header(reqwest::header::COOKIE, &cookie_val)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::OK);
    assert_eq!(
        res.headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .unwrap()
            .to_str()
            .unwrap(),
        "0"
    );
    assert!(res.bytes().await.unwrap().is_empty());

    // Empty file with range returns 416
    let res = client
        .get(format!("{}/empty.txt", origin))
        .header(reqwest::header::COOKIE, &cookie_val)
        .header(reqwest::header::RANGE, "bytes=0-1")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), reqwest::StatusCode::RANGE_NOT_SATISFIABLE);

    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn test_concurrency_and_permit_drain() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("test.txt"), "concurrency test content").unwrap();

    let handle = start(root.to_path_buf()).await.unwrap();
    let origin = handle.origin.clone();
    let bootstrap_url = handle.bootstrap_url.clone();

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let boot_res = client.get(&bootstrap_url).send().await.unwrap();
    let cookie_val = boot_res
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();

    // Launch 16 concurrent requests
    let mut tasks = Vec::new();
    for _ in 0..16 {
        let c = client.clone();
        let u = format!("{}/test.txt", origin);
        let cv = cookie_val.clone();
        tasks.push(tokio::spawn(async move {
            let res = c
                .get(u)
                .header(reqwest::header::COOKIE, cv)
                .send()
                .await
                .unwrap();
            assert_eq!(res.status(), reqwest::StatusCode::OK);
            let text = res.text().await.unwrap();
            assert_eq!(text, "concurrency test content");
        }));
    }

    for task in tasks {
        task.await.unwrap();
    }

    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn test_shutdown_and_port_release() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("index.html"), "Running").unwrap();

    let handle = start(root.to_path_buf()).await.unwrap();
    let bootstrap_url = handle.bootstrap_url.clone();

    // Verify it is reachable
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let boot_res = client.get(&bootstrap_url).send().await.unwrap();
    assert_eq!(boot_res.status(), reqwest::StatusCode::SEE_OTHER);

    // Shutdown
    handle.shutdown().await.expect("shutdown must succeed");

    // Port must be released: subsequent requests fail with connection refused/error
    tokio::time::sleep(Duration::from_millis(50)).await;
    let err_res = client.get(&bootstrap_url).send().await;
    assert!(
        err_res.is_err(),
        "connecting after shutdown must fail as port is released"
    );
}

#[tokio::test]
async fn test_start_with_file_root_fails() {
    let dir = tempdir().unwrap();
    let file_path = dir.path().join("regular_file.txt");
    fs::write(&file_path, "not a directory").unwrap();

    let res = start(file_path).await;
    assert!(
        res.is_err(),
        "Starting server with regular file root must fail"
    );
    match res.unwrap_err() {
        ashfall_client_core::http_server::ServerError::NotADirectory(_) => {}
        other => panic!("Expected NotADirectory, got {:?}", other),
    }
}

#[tokio::test]
async fn test_drop_server_handle_releases_port() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("index.html"), "Drop test").unwrap();

    let bootstrap_url;
    {
        let handle = start(root.to_path_buf()).await.unwrap();
        bootstrap_url = handle.bootstrap_url.clone();

        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let res = client.get(&bootstrap_url).send().await.unwrap();
        assert_eq!(res.status(), reqwest::StatusCode::SEE_OTHER);
        // handle is dropped at the end of this block
    }

    tokio::time::sleep(Duration::from_millis(50)).await;
    let client = reqwest::Client::builder().build().unwrap();
    let res = client.get(&bootstrap_url).send().await;
    assert!(res.is_err(), "Port must be released when handle is dropped");
}

#[tokio::test]
async fn test_duplicate_headers_rejected() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("index.html"), "Hello").unwrap();

    let handle = start(root.to_path_buf()).await.unwrap();
    let origin = handle.origin.clone();
    let bootstrap_url = handle.bootstrap_url.clone();

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let boot_res = client.get(&bootstrap_url).send().await.unwrap();
    let cookie_val = boot_res
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let port_str = origin.strip_prefix("http://127.0.0.1:").unwrap();
    let port_num: u16 = port_str.parse().unwrap();

    // 1. Duplicate Host headers -> 400 Bad Request
    let raw_dup_host = format!(
        "GET /index.html HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nHost: 127.0.0.1:{}\r\nCookie: {}\r\nConnection: close\r\n\r\n",
        port_num, port_num, cookie_val
    );
    let resp = send_raw_http(port_num, &raw_dup_host).await;
    assert!(
        resp.starts_with("HTTP/1.1 400 Bad Request"),
        "Duplicate Host must return 400, got: {}",
        resp
    );

    // 2. Duplicate Cookie headers -> 403 Forbidden
    let raw_dup_cookie = format!(
        "GET /index.html HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nCookie: {}\r\nCookie: extra=1\r\nConnection: close\r\n\r\n",
        port_num, cookie_val
    );
    let resp = send_raw_http(port_num, &raw_dup_cookie).await;
    assert!(
        resp.starts_with("HTTP/1.1 403 Forbidden"),
        "Duplicate Cookie must return 403, got: {}",
        resp
    );

    handle.shutdown().await.unwrap();
}
