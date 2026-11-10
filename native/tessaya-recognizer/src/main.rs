//! Tessaya's recogniser as a service on his own machines (a primary server, then a second): while the dictation key is
//! held the desktop streams 16 kHz mono PCM here over a WebSocket on the tailnet, and gets live words back, then the
//! text at release. The same transcribe-cpp model and the same chunking as the desktop sidecar (`live.rs`, shared
//! source): 6 s pieces cut at pauses with 3 s of context, previews of the uncut audio, a preview at his pause that a
//! release takes when no speech follows it. Audio is never written to disk here.
//!
//! Protocol: the request carries `Authorization: Bearer <token>`. Text frames from the client: {"cmd":"health"},
//! {"cmd":"begin","language":null}, {"cmd":"end"}; binary frames are PCM16 LE samples. From the server:
//! {"ev":"health","queue":n,"busy":bool}, {"ev":"partial","text","pause"}, {"ev":"text","text","inferMs","pieces",
//! "reused","releaseMs"}, {"ev":"error","message"}.
#[path = "../../baton-dictation/src/live.rs"]
#[allow(dead_code)]
mod live;
mod engine;

use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{json, Value};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::{accept_hdr, Message};

use engine::{Job, Reply};

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
    let token = Arc::new(token);
    for stream in listener.incoming().flatten() {
        let (token, jobs, queue) = (token.clone(), jobs.clone(), queue.clone());
        std::thread::spawn(move || serve(stream, &token, jobs, queue));
    }
}

/// One connection: health checks and any number of dictations, one at a time.
fn serve(stream: std::net::TcpStream, token: &str, jobs: Sender<Job>, queue: Arc<AtomicUsize>) {
    let _ = stream.set_nodelay(true);
    let check = |req: &Request, res: Response| -> Result<Response, ErrorResponse> {
        let ok = req.headers().get("authorization").and_then(|v| v.to_str().ok()) == Some(&format!("Bearer {token}"));
        if ok {
            Ok(res)
        } else {
            let mut refused = ErrorResponse::new(Some("unauthorized".into()));
            *refused.status_mut() = tungstenite::http::StatusCode::UNAUTHORIZED;
            Err(refused)
        }
    };
    let Ok(socket) = accept_hdr(stream, check) else { return };
    // Reads wait at most 10 ms, so the words going back are never held up behind one.
    let _ = socket.get_ref().set_read_timeout(Some(std::time::Duration::from_millis(10)));
    let socket = Arc::new(Mutex::new(socket));
    let (replies, answers) = channel::<Reply>();
    // Words go back as soon as the engine has them, from their own thread.
    {
        let socket = socket.clone();
        std::thread::spawn(move || {
            for reply in answers {
                let line = match reply {
                    Reply::Partial { text, pause } => json!({"ev": "partial", "text": text, "pause": pause}),
                    Reply::Text { text, infer_ms, pieces, reused, release_ms } => json!({
                        "ev": "text", "text": text, "inferMs": infer_ms, "pieces": pieces, "reused": reused,
                        "releaseMs": release_ms,
                    }),
                    Reply::Error(message) => json!({"ev": "error", "message": message}),
                };
                if socket.lock().unwrap().send(Message::text(line.to_string())).is_err() {
                    return;
                }
            }
        });
    }
    let mut dictation: Option<Sender<engine::Feed>> = None;
    loop {
        // The socket is read with the lock held only for one frame; the writer thread takes it between frames.
        let message = {
            let mut s = socket.lock().unwrap();
            s.read()
        };
        let message = match message {
            Ok(message) => message,
            Err(tungstenite::Error::Io(e))
                if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) =>
            {
                continue
            }
            Err(_) => break,
        };
        match message {
            Message::Binary(bytes) => {
                if let Some(feed) = &dictation {
                    let pcm: Vec<f32> =
                        bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();
                    let _ = feed.send(engine::Feed::Audio(pcm));
                }
            }
            Message::Text(text) => {
                let value: Value = serde_json::from_str(text.as_str()).unwrap_or(Value::Null);
                match value["cmd"].as_str() {
                    Some("health") => {
                        let busy = queue.load(Ordering::SeqCst);
                        let line = json!({"ev": "health", "queue": busy, "busy": busy > 0});
                        let _ = socket.lock().unwrap().send(Message::text(line.to_string()));
                    }
                    Some("begin") => {
                        let (feed, audio) = channel();
                        let language = value["language"].as_str().map(str::to_string);
                        queue.fetch_add(1, Ordering::SeqCst);
                        let _ = jobs.send(Job { audio, replies: replies.clone(), language });
                        dictation = Some(feed);
                    }
                    Some("end") => {
                        if let Some(feed) = dictation.take() {
                            let _ = feed.send(engine::Feed::End(Instant::now()));
                        }
                    }
                    _ => {}
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    // A connection that drops mid-dictation abandons it; the engine moves on.
    if let Some(feed) = dictation {
        let _ = feed.send(engine::Feed::Abort);
    }
}
