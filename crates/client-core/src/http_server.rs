use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderValue, Method, Request, Response, StatusCode};
use futures_util::Stream;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::io::ReaderStream;

use crate::path_policy;
use crate::range;
use crate::session::{SessionState, SESSION_COOKIE_NAME};

pub const DEFAULT_CSP: &str = "\
    default-src 'self'; \
    script-src 'self'; \
    worker-src 'self' blob:; \
    style-src 'self' 'unsafe-inline'; \
    img-src 'self' data: blob:; \
    media-src 'self' blob:; \
    font-src 'self' data:; \
    connect-src 'self' ipc: http://ipc.localhost; \
    frame-ancestors 'none'; \
    base-uri 'self'; \
    form-action 'self';";

#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("root path is not a directory: {0:?}")]
    NotADirectory(PathBuf),
    #[error("server task failed: {0}")]
    Task(String),
    #[error("shutdown timeout")]
    Timeout,
}

struct AppState {
    root: PathBuf,
    port: u16,
    session: Arc<SessionState>,
    semaphore: Arc<Semaphore>,
}

pub struct ServerHandle {
    pub origin: String,
    pub bootstrap_url: String,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    server_task: Option<tokio::task::JoinHandle<std::io::Result<()>>>,
    semaphore: Arc<Semaphore>,
}

impl std::fmt::Debug for ServerHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServerHandle")
            .field("origin", &self.origin)
            .field("bootstrap_url", &"[REDACTED]")
            .finish()
    }
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        self.semaphore.close();
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(task) = self.server_task.take() {
            task.abort();
        }
    }
}

impl ServerHandle {
    pub async fn shutdown(mut self) -> Result<(), ServerError> {
        self.semaphore.close();
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(mut task) = self.server_task.take() {
            match tokio::time::timeout(std::time::Duration::from_secs(3), &mut task).await {
                Ok(Ok(Ok(()))) => Ok(()),
                Ok(Ok(Err(e))) => Err(ServerError::Task(e.to_string())),
                Ok(Err(join_err)) => Err(ServerError::Task(join_err.to_string())),
                Err(_) => {
                    task.abort();
                    let _ = (&mut task).await;
                    Err(ServerError::Timeout)
                }
            }
        } else {
            Ok(())
        }
    }
}

pub struct PermitStream<S> {
    inner: S,
    _permit: Option<OwnedSemaphorePermit>,
}

impl<S> PermitStream<S> {
    pub fn new(inner: S, permit: OwnedSemaphorePermit) -> Self {
        Self {
            inner,
            _permit: Some(permit),
        }
    }
}

impl<S: Stream + Unpin> Stream for PermitStream<S> {
    type Item = S::Item;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let res = Pin::new(&mut self.inner).poll_next(cx);
        if let Poll::Ready(None) = &res {
            self._permit.take();
        }
        res
    }
}

fn make_response<B: Into<Body>>(
    method: &Method,
    status: StatusCode,
    body: B,
    headers: impl IntoIterator<Item = (header::HeaderName, HeaderValue)>,
) -> Response<Body> {
    let mut builder = Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store, private")
        .header("referrer-policy", "no-referrer")
        .header("content-security-policy", DEFAULT_CSP)
        .header("x-content-type-options", "nosniff");

    for (name, val) in headers {
        builder = builder.header(name, val);
    }

    let final_body = if method == Method::HEAD {
        Body::empty()
    } else {
        body.into()
    };

    builder.body(final_body).unwrap_or_else(|_| {
        Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Body::empty())
            .unwrap()
    })
}

pub async fn start(root: PathBuf) -> Result<ServerHandle, ServerError> {
    let canonical_root = root.canonicalize().map_err(ServerError::Io)?;
    if !canonical_root.is_dir() {
        return Err(ServerError::NotADirectory(canonical_root));
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(ServerError::Io)?;
    let local_addr = listener.local_addr().map_err(ServerError::Io)?;
    let port = local_addr.port();

    let session = SessionState::new();
    let origin = format!("http://127.0.0.1:{}", port);
    let bootstrap_url = format!("{}/__bootstrap/{}", origin, session.bootstrap_token());

    let semaphore = Arc::new(Semaphore::new(16));
    let state = Arc::new(AppState {
        root: canonical_root,
        port,
        session,
        semaphore: semaphore.clone(),
    });

    let app = axum::Router::new()
        .fallback(handle_request)
        .with_state(state);

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let server = axum::serve(listener, app).with_graceful_shutdown(async move {
        let _ = shutdown_rx.await;
    });

    let server_task = tokio::spawn(server.into_future());

    Ok(ServerHandle {
        origin,
        bootstrap_url,
        shutdown_tx: Some(shutdown_tx),
        server_task: Some(server_task),
        semaphore,
    })
}

async fn handle_request(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
) -> Response<Body> {
    let method = req.method().clone();

    // 1. Method check: only GET and HEAD supported; other methods return 405
    if method != Method::GET && method != Method::HEAD {
        return make_response(
            &method,
            StatusCode::METHOD_NOT_ALLOWED,
            "405 Method Not Allowed",
            [(header::ALLOW, HeaderValue::from_static("GET, HEAD"))],
        );
    }

    // 2. Reject duplicate headers to prevent ambiguity / smuggling (fail-closed)
    if req.headers().get_all(header::HOST).iter().count() > 1 {
        return make_response(&method, StatusCode::BAD_REQUEST, "400 Bad Request: Duplicate Host headers", []);
    }
    if req.headers().get_all(header::ORIGIN).iter().count() > 1 {
        return make_response(&method, StatusCode::FORBIDDEN, "403 Forbidden: Duplicate Origin headers", []);
    }
    if req.headers().get_all(header::RANGE).iter().count() > 1 {
        return make_response(&method, StatusCode::BAD_REQUEST, "400 Bad Request: Duplicate Range headers", []);
    }
    if req.headers().get_all(header::COOKIE).iter().count() > 1 {
        return make_response(&method, StatusCode::FORBIDDEN, "403 Forbidden: Duplicate Cookie headers", []);
    }

    // 3. Host check: must match exact 127.0.0.1:{actual_port}
    let expected_host = format!("127.0.0.1:{}", state.port);
    let host_valid = match req.headers().get(header::HOST) {
        Some(h) => h.to_str().map(|v| v == expected_host).unwrap_or(false),
        None => false,
    };
    if !host_valid {
        return make_response(&method, StatusCode::BAD_REQUEST, "400 Bad Request: Invalid Host", []);
    }

    // 4. Origin check: if Origin present, must match exact http://127.0.0.1:{actual_port}
    let expected_origin = format!("http://127.0.0.1:{}", state.port);
    if let Some(origin) = req.headers().get(header::ORIGIN) {
        let origin_str = match origin.to_str() {
            Ok(s) => s,
            Err(_) => {
                return make_response(&method, StatusCode::FORBIDDEN, "403 Forbidden: Invalid Origin header", []);
            }
        };
        if origin_str != expected_origin {
            return make_response(&method, StatusCode::FORBIDDEN, "403 Forbidden: Origin mismatch", []);
        }
    }

    // 5. Sec-Fetch-Site check: reject cross-site requests
    if let Some(sfs) = req.headers().get("sec-fetch-site") {
        if let Ok(s) = sfs.to_str() {
            if s.eq_ignore_ascii_case("cross-site") {
                return make_response(&method, StatusCode::FORBIDDEN, "403 Forbidden: Cross-site request rejected", []);
            }
        }
    }

    let path = req.uri().path();

    // 6. Bootstrap handling: /__bootstrap/<token>
    if let Some(token) = path.strip_prefix("/__bootstrap/") {
        if method != Method::GET {
            return make_response(
                &method,
                StatusCode::METHOD_NOT_ALLOWED,
                "405 Method Not Allowed",
                [(header::ALLOW, HeaderValue::from_static("GET"))],
            );
        }

        if state.session.consume_bootstrap(token) {
            let cookie_val = format!(
                "{}={}; Path=/; HttpOnly; SameSite=Strict",
                SESSION_COOKIE_NAME,
                state.session.session_cookie()
            );
            return make_response(
                &method,
                StatusCode::SEE_OTHER,
                Body::empty(),
                [
                    (header::LOCATION, HeaderValue::from_static("/index.html")),
                    (header::SET_COOKIE, HeaderValue::try_from(cookie_val).unwrap()),
                ],
            );
        } else {
            return make_response(
                &method,
                StatusCode::FORBIDDEN,
                "403 Forbidden: Bootstrap token invalid or already consumed",
                [],
            );
        }
    }

    // 7. Cookie authentication check for all subsequent file requests
    let has_valid_cookie = match req.headers().get(header::COOKIE) {
        Some(cookie_val) => match cookie_val.to_str() {
            Ok(c_str) => state.session.validate_cookie(c_str),
            Err(_) => false,
        },
        None => false,
    };

    if !has_valid_cookie {
        return make_response(&method, StatusCode::FORBIDDEN, "403 Forbidden: Session cookie required", []);
    }

    // 8. Resolve requested file path securely using path_policy
    let resolved_path = match path_policy::resolve_file(&state.root, path) {
        Ok(p) => p,
        Err(e) => {
            let status = StatusCode::from_u16(e.status_code()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            return make_response(
                &method,
                status,
                e.to_string(),
                [(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"))],
            );
        }
    };

    // 9. Acquire semaphore permit (concurrency limit: 16)
    let permit = match state.semaphore.clone().acquire_owned().await {
        Ok(p) => p,
        Err(_) => {
            return make_response(&method, StatusCode::SERVICE_UNAVAILABLE, "503 Service Unavailable", []);
        }
    };

    // 10. Open file and inspect metadata
    let mut file = match tokio::fs::File::open(&resolved_path).await {
        Ok(f) => f,
        Err(e) => {
            drop(permit);
            return make_response(
                &method,
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to open file: {}", e),
                [(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"))],
            );
        }
    };

    let meta = match file.metadata().await {
        Ok(m) => m,
        Err(e) => {
            drop(permit);
            return make_response(
                &method,
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to read metadata: {}", e),
                [(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"))],
            );
        }
    };

    let file_size = meta.len();
    let mime = mime_guess::from_path(&resolved_path)
        .first_or_octet_stream()
        .to_string();
    let mime_val = HeaderValue::try_from(mime).unwrap_or(HeaderValue::from_static("application/octet-stream"));

    // 11. Process Range request
    if let Some(range_raw) = req.headers().get(header::RANGE) {
        let range_str = match range_raw.to_str() {
            Ok(s) => s,
            Err(_) => {
                drop(permit);
                return make_response(&method, StatusCode::BAD_REQUEST, "400 Bad Request: Invalid Range header encoding", []);
            }
        };

        match range::parse_range(range_str, file_size) {
            Ok(byte_range) => {
                let start = byte_range.start;
                let end = byte_range.end;
                let range_len = end.checked_sub(start).and_then(|d| d.checked_add(1)).unwrap_or(0);
                let content_range = format!("bytes {}-{}/{}", start, end, file_size);
                let content_range_val = HeaderValue::try_from(content_range).unwrap();
                let len_val = HeaderValue::from_str(&range_len.to_string()).unwrap();

                if method == Method::HEAD {
                    drop(permit);
                    return make_response(
                        &method,
                        StatusCode::PARTIAL_CONTENT,
                        Body::empty(),
                        [
                            (header::CONTENT_TYPE, mime_val),
                            (header::CONTENT_RANGE, content_range_val),
                            (header::CONTENT_LENGTH, len_val),
                            (header::ACCEPT_RANGES, HeaderValue::from_static("bytes")),
                        ],
                    );
                }

                if let Err(e) = file.seek(std::io::SeekFrom::Start(start)).await {
                    drop(permit);
                    return make_response(
                        &method,
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Seek error: {}", e),
                        [(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"))],
                    );
                }

                let take = file.take(range_len);
                let stream = PermitStream::new(ReaderStream::new(take), permit);
                let body = Body::from_stream(stream);

                return make_response(
                    &method,
                    StatusCode::PARTIAL_CONTENT,
                    body,
                    [
                        (header::CONTENT_TYPE, mime_val),
                        (header::CONTENT_RANGE, content_range_val),
                        (header::CONTENT_LENGTH, len_val),
                        (header::ACCEPT_RANGES, HeaderValue::from_static("bytes")),
                    ],
                );
            }
            Err(range::RangeError::Unsatisfiable) => {
                drop(permit);
                let content_range = format!("bytes */{}", file_size);
                let content_range_val = HeaderValue::try_from(content_range).unwrap();
                return make_response(
                    &method,
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    Body::empty(),
                    [
                        (header::CONTENT_RANGE, content_range_val),
                        (header::ACCEPT_RANGES, HeaderValue::from_static("bytes")),
                    ],
                );
            }
            Err(range::RangeError::Malformed | range::RangeError::Multiple) => {
                drop(permit);
                return make_response(
                    &method,
                    StatusCode::BAD_REQUEST,
                    "400 Bad Request: Invalid or multiple ranges",
                    [(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"))],
                );
            }
        }
    }

    // 12. Full file response (No Range header)
    let len_val = HeaderValue::from_str(&file_size.to_string()).unwrap();

    if method == Method::HEAD {
        drop(permit);
        return make_response(
            &method,
            StatusCode::OK,
            Body::empty(),
            [
                (header::CONTENT_TYPE, mime_val),
                (header::CONTENT_LENGTH, len_val),
                (header::ACCEPT_RANGES, HeaderValue::from_static("bytes")),
            ],
        );
    }

    if file_size == 0 {
        drop(permit);
        return make_response(
            &method,
            StatusCode::OK,
            Body::empty(),
            [
                (header::CONTENT_TYPE, mime_val),
                (header::CONTENT_LENGTH, HeaderValue::from_static("0")),
                (header::ACCEPT_RANGES, HeaderValue::from_static("bytes")),
            ],
        );
    }

    let stream = PermitStream::new(ReaderStream::new(file), permit);
    let body = Body::from_stream(stream);

    make_response(
        &method,
        StatusCode::OK,
        body,
        [
            (header::CONTENT_TYPE, mime_val),
            (header::CONTENT_LENGTH, len_val),
            (header::ACCEPT_RANGES, HeaderValue::from_static("bytes")),
        ],
    )
}
