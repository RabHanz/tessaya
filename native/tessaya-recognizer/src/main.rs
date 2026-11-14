//! Tessaya's recogniser as a service on his own machines (a primary server, then a second): while the dictation key is
//! held the desktop streams 16 kHz mono PCM here over a WebSocket on the tailnet, and gets live words back, then the
//! text at release. The same transcribe-cpp model and the same chunking as the desktop sidecar (`live.rs`, shared
//! source). Audio is never written to disk here.
//!
//! Protocol: the request carries `Authorization: Bearer <token>`. Text frames from the client: {"cmd":"health"},
//! {"cmd":"begin","language":null}, {"cmd":"end"}; binary frames are PCM16 LE samples. From the server:
//! {"ev":"health","queue":n,"busy":bool}, {"ev":"partial","text","pause"}, {"ev":"text","text","inferMs","pieces",
//! "reused","releaseMs"}, {"ev":"error","message"}.
#[path = "../../baton-dictation/src/live.rs"]
#[allow(dead_code)]
mod live;
mod engine;

use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{channel, sync_channel, Sender, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::{accept_hdr, Message, WebSocket};

use engine::{Feed, Job, Reply};

/// Connections served at once; more are closed at once. One person dictates, with a health check or two beside.
const MAX_CONNECTIONS: usize = 8;
/// How long the opening handshake may take.
const HANDSHAKE: Duration = Duration::from_secs(5);
/// A dictation whose client sends nothing for this long is dropped: a laptop that slept or lost the network.
const SILENCE: Duration = Duration::from_secs(2);
/// The longest dictation taken, in samples (120 s); past it the dictation ends with an error.
const MAX_SAMPLES: usize = 120 * 16_000;
/// Audio blocks waiting for the engine (about 10 s of 20 ms blocks); a fuller queue means it cannot keep up.
const FEED_BOUND: usize = 500;

fn main() {
    let addr = std::env::var("RECOGNIZER_ADDR").unwrap_or_else(|_| "127.0.0.1:8791".to_string());
    let model = std::env::var("RECOGNIZER_MODEL").expect("RECOGNIZER_MODEL: the TDT v3 GGUF");
    let token = std::fs::read_to_string(std::env::var("RECOGNIZER_TOKEN_FILE").expect("RECOGNIZER_TOKEN_FILE"))
        .expect("the token file")
        .trim()
        .to_string();
    let threads: i32 = std::env::var("RECOGNIZER_THREADS").ok().and_then(|v| v.parse().ok()).unwrap_or(4);
    let (jobs, queue) = engine::start(std::path::Path::new(&model), threads);
    let listener = TcpListener::bind(&addr).expect("bind");
    eprintln!("tessaya-recognizer listening on {addr}");
    accept_loop(listener, Arc::new(token), jobs, queue);
}

fn accept_loop(listener: TcpListener, token: Arc<String>, jobs: Sender<Job>, queue: Arc<AtomicUsize>) {
    let open = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming().flatten() {
        if open.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            open.fetch_sub(1, Ordering::SeqCst);
            continue;
        }
        let (token, jobs, queue, open) = (token.clone(), jobs.clone(), queue.clone(), open.clone());
        std::thread::spawn(move || {
            serve(stream, &token, jobs, queue);
            open.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

/// Equal in time whatever the bytes: a wrong token takes as long to refuse as a nearly right one.
fn same_secret(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// One connection: health checks and dictations, one at a time.
fn serve(stream: TcpStream, token: &str, jobs: Sender<Job>, queue: Arc<AtomicUsize>) {
    let _ = stream.set_nodelay(true);
    // A client that connects and says nothing is not waited on.
    let _ = stream.set_read_timeout(Some(HANDSHAKE));
    let _ = stream.set_write_timeout(Some(HANDSHAKE));
    let expected = format!("Bearer {token}");
    let check = |req: &Request, res: Response| -> Result<Response, ErrorResponse> {
        let given = req.headers().get("authorization").map(|v| v.as_bytes()).unwrap_or_default();
        if same_secret(given, expected.as_bytes()) {
            Ok(res)
        } else {
            let mut refused = ErrorResponse::new(Some("unauthorized".into()));
            *refused.status_mut() = tungstenite::http::StatusCode::UNAUTHORIZED;
            Err(refused)
        }
    };
    let Ok(mut socket) = accept_hdr(stream, check) else { return };
    // Reads wait at most 10 ms, then the words waiting go back: one thread owns the socket, so a reply is never held up
    // behind the reader (a shared lock starved replies for 5 to 25 s, 14 Nov).
    let _ = socket.get_ref().set_read_timeout(Some(Duration::from_millis(10)));
    let (replies, answers) = channel::<Reply>();
    let mut dictation: Option<(SyncSender<Feed>, usize)> = None;
    let mut heard_at = Instant::now();
    let send = |socket: &mut WebSocket<TcpStream>, line: Value| socket.send(Message::text(line.to_string())).is_ok();
    let stop = |socket: &mut WebSocket<TcpStream>, dictation: &mut Option<(SyncSender<Feed>, usize)>, why: &str| {
        if let Some((feed, _)) = dictation.take() {
            let _ = feed.try_send(Feed::Abort);
        }
        send(socket, json!({"ev": "error", "message": why}));
    };
    loop {
        while let Ok(reply) = answers.try_recv() {
            if !send(&mut socket, reply_line(reply)) {
                return abandon(dictation);
            }
        }
        let message = socket.read();
        let message = match message {
            Ok(message) => {
                heard_at = Instant::now();
                message
            }
            Err(tungstenite::Error::Io(e))
                if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) =>
            {
                if dictation.is_some() && heard_at.elapsed() >= SILENCE {
                    stop(&mut socket, &mut dictation, "no audio for 2 s; dictation dropped");
                    break;
                }
                continue;
            }
            Err(_) => break,
        };
        match message {
            Message::Binary(bytes) => {
                let Some((feed, samples)) = &mut dictation else { continue };
                *samples += bytes.len() / 2;
                if *samples > MAX_SAMPLES {
                    stop(&mut socket, &mut dictation, "dictation over 120 s; dropped");
                    continue;
                }
                let pcm: Vec<f32> =
                    bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();
                match feed.try_send(Feed::Audio(pcm)) {
                    Ok(()) => {}
                    Err(TrySendError::Full(_)) => stop(&mut socket, &mut dictation, "recogniser behind; dictation dropped"),
                    Err(TrySendError::Disconnected(_)) => dictation = None,
                }
            }
            Message::Text(text) => {
                let value: Value = serde_json::from_str(text.as_str()).unwrap_or(Value::Null);
                match value["cmd"].as_str() {
                    Some("health") => {
                        let busy = queue.load(Ordering::SeqCst);
                        send(&mut socket, json!({"ev": "health", "queue": busy, "busy": busy > 0}));
                    }
                    Some("begin") if dictation.is_some() => {
                        send(&mut socket, json!({"ev": "error", "message": "a dictation is already running on this connection"}));
                    }
                    Some("begin") => {
                        let (feed, audio) = sync_channel(FEED_BOUND);
                        let language = value["language"].as_str().map(str::to_string);
                        queue.fetch_add(1, Ordering::SeqCst);
                        if jobs.send(Job { audio, replies: replies.clone(), language }).is_err() {
                            queue.fetch_sub(1, Ordering::SeqCst);
                            send(&mut socket, json!({"ev": "error", "message": "recogniser stopped"}));
                            break;
                        }
                        dictation = Some((feed, 0));
                        heard_at = Instant::now();
                    }
                    Some("end") => {
                        if let Some((feed, _)) = dictation.take() {
                            let _ = feed.send(Feed::End(Instant::now()));
                        }
                    }
                    _ => {}
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    abandon(dictation);
}

/// A connection that drops mid-dictation abandons it; the engine moves on.
fn abandon(dictation: Option<(SyncSender<Feed>, usize)>) {
    if let Some((feed, _)) = dictation {
        let _ = feed.try_send(Feed::Abort);
    }
}

fn reply_line(reply: Reply) -> Value {
    match reply {
        Reply::Partial { text, pause } => json!({"ev": "partial", "text": text, "pause": pause}),
        Reply::Text { text, infer_ms, pieces, reused, release_ms } => json!({
            "ev": "text", "text": text, "inferMs": infer_ms, "pieces": pieces, "reused": reused,
            "releaseMs": release_ms,
        }),
        Reply::Error(message) => json!({"ev": "error", "message": message}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::Receiver;
    use tungstenite::client::IntoClientRequest;

    /// The service's connection handling with no model: jobs are taken off the queue by the test itself.
    fn listen() -> (String, Receiver<Job>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = format!("ws://{}", listener.local_addr().unwrap());
        let (jobs, incoming) = channel();
        std::thread::spawn(move || accept_loop(listener, Arc::new("secret".into()), jobs, Arc::new(AtomicUsize::new(0))));
        (addr, incoming)
    }

    fn client(addr: &str, token: &str) -> Result<tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>, ()> {
        let mut request = addr.into_client_request().unwrap();
        request.headers_mut().insert("authorization", format!("Bearer {token}").parse().unwrap());
        tungstenite::connect(request).map(|(s, _)| s).map_err(|_| ())
    }

    fn next_text(socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>) -> Value {
        loop {
            if let Ok(Message::Text(t)) = socket.read() {
                return serde_json::from_str(t.as_str()).unwrap();
            }
        }
    }

    #[test]
    fn compares_tokens_in_full() {
        assert!(same_secret(b"Bearer abc", b"Bearer abc"));
        assert!(!same_secret(b"Bearer abd", b"Bearer abc"));
        assert!(!same_secret(b"Bearer ab", b"Bearer abc"));
    }

    #[test]
    fn refuses_a_wrong_token_and_a_second_begin() {
        let (addr, jobs) = listen();
        assert!(client(&addr, "wrong").is_err());
        let mut socket = client(&addr, "secret").unwrap();
        socket.send(Message::text(r#"{"cmd":"begin"}"#)).unwrap();
        let _job = jobs.recv_timeout(Duration::from_secs(2)).unwrap();
        socket.send(Message::text(r#"{"cmd":"begin"}"#)).unwrap();
        assert_eq!(next_text(&mut socket)["ev"], "error");
    }

    #[test]
    fn sends_the_engine_s_words_back_while_the_client_is_quiet() {
        let (addr, jobs) = listen();
        let mut socket = client(&addr, "secret").unwrap();
        socket.send(Message::text(r#"{"cmd":"begin"}"#)).unwrap();
        let job = jobs.recv_timeout(Duration::from_secs(2)).unwrap();
        socket.send(Message::text(r#"{"cmd":"end"}"#)).unwrap();
        let started = Instant::now();
        let reply = Reply::Text { text: "what time is it".into(), infer_ms: 0, pieces: 1, reused: false, release_ms: 0 };
        job.replies.send(reply).unwrap();
        assert_eq!(next_text(&mut socket)["text"], "what time is it");
        // A shared socket lock held by the reader kept this waiting 5 to 25 s on 14 Nov; well under the 2 s silence limit.
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn drops_a_dictation_after_two_seconds_of_silence() {
        let (addr, jobs) = listen();
        let mut socket = client(&addr, "secret").unwrap();
        socket.send(Message::text(r#"{"cmd":"begin"}"#)).unwrap();
        let job = jobs.recv_timeout(Duration::from_secs(2)).unwrap();
        let started = Instant::now();
        let reply = next_text(&mut socket);
        assert_eq!(reply["ev"], "error");
        assert!(started.elapsed() >= Duration::from_millis(1_900));
        assert!(matches!(job.audio.recv_timeout(Duration::from_secs(1)), Ok(Feed::Abort)));
    }

    #[test]
    fn drops_a_dictation_past_120_seconds() {
        let (addr, jobs) = listen();
        let mut socket = client(&addr, "secret").unwrap();
        socket.send(Message::text(r#"{"cmd":"begin"}"#)).unwrap();
        let job = jobs.recv_timeout(Duration::from_secs(2)).unwrap();
        // Drain the audio as an engine would, so only the length limit can stop it.
        std::thread::spawn(move || while job.audio.recv().is_ok() {});
        let block = vec![0u8; 32_000]; // 1 s
        for _ in 0..121 {
            socket.send(Message::binary(block.clone())).unwrap();
        }
        assert_eq!(next_text(&mut socket)["message"], "dictation over 120 s; dropped");
    }
}
