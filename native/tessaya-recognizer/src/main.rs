//! Tessaya's recogniser as a service on his own machines (a primary server, then a second): while the dictation key is
//! held the desktop streams 16 kHz mono PCM here over a WebSocket on the tailnet, and gets live words back, then the
//! text at release. The same transcribe-cpp model and the same chunking as the desktop sidecar (`live.rs`, shared
//! source). Audio is never written to disk here.
//!
//! Protocol: the request carries `Authorization: Bearer <token>`. Text frames from the client: {"cmd":"health"},
//! {"cmd":"begin","language":null}, {"cmd":"end"}; binary frames are PCM16 LE samples. From the server:
//! {"ev":"health","queue":n,"busy":bool,"backlogMs":n,"rtf":x|null,"cpuPct":n} (audio received and not yet decoded;
//! the recent decode speed, null when nothing was decoded in the last 2 minutes; the CPU busy over the last second), {"ev":"partial","text","pause"}, {"ev":"text","text","inferMs","pieces",
//! "reused","releaseMs"}, {"ev":"error","message"}.
#[path = "../../baton-dictation/src/live.rs"]
#[allow(dead_code)]
mod live;
mod engine;

use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, sync_channel, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::{accept_hdr, Message};

use engine::{Feed, Job, Reply};

/// Connections served at once; more are closed at once. Each of his desktops keeps one open.
const MAX_CONNECTIONS: usize = 8;
/// How long the opening handshake may take.
const HANDSHAKE: Duration = Duration::from_secs(5);
/// A dictation whose client sends nothing for this long is dropped: a laptop that slept or lost the network.
const SILENCE: Duration = Duration::from_secs(2);
/// A connection with no dictation that sends nothing for this long is closed; the desktop pings every 10 s.
const IDLE: Duration = Duration::from_secs(30);
/// The longest dictation taken, in samples (120 s); past it the dictation ends with an error.
const MAX_SAMPLES: usize = 120 * 16_000;
/// Audio blocks waiting for the engine (about 10 s of 20 ms blocks); a fuller queue means it cannot keep up.
const FEED_BOUND: usize = 500;

/// The share of the CPU busy over the last second, every program and the hypervisor's steal included.
static CPU_PCT: AtomicU64 = AtomicU64::new(0);

/// Reads /proc/stat once a second: the cheapest live sign of a machine other work has filled, which the decode speed
/// only shows once a dictation has run on it.
fn probe_cpu() {
    let sample = || -> Option<(u64, u64)> {
        let stat = std::fs::read_to_string("/proc/stat").ok()?;
        let fields: Vec<u64> = stat.lines().next()?.split_whitespace().skip(1).filter_map(|f| f.parse().ok()).collect();
        // user nice system idle iowait irq softirq steal: idle and iowait are the CPU free.
        let total: u64 = fields.iter().take(8).sum();
        Some((total, total - fields.get(3)? - fields.get(4)?))
    };
    std::thread::spawn(move || {
        let Some(mut last) = sample() else { return };
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let Some(now) = sample() else { return };
            let (total, busy) = (now.0 - last.0, now.1 - last.1);
            CPU_PCT.store(if total == 0 { 0 } else { busy * 100 / total }, Ordering::Relaxed);
            last = now;
        }
    });
}

fn main() {
    let addr = std::env::var("RECOGNIZER_ADDR").unwrap_or_else(|_| "127.0.0.1:8791".to_string());
    let model = std::env::var("RECOGNIZER_MODEL").expect("RECOGNIZER_MODEL: the TDT v3 GGUF");
    let token = std::fs::read_to_string(std::env::var("RECOGNIZER_TOKEN_FILE").expect("RECOGNIZER_TOKEN_FILE"))
        .expect("the token file")
        .trim()
        .to_string();
    let threads: i32 = std::env::var("RECOGNIZER_THREADS").ok().and_then(|v| v.parse().ok()).unwrap_or(4);
    let (jobs, queue) = engine::start(std::path::Path::new(&model), threads);
    probe_cpu();
    let listener = TcpListener::bind(&addr).expect("bind");
    eprintln!("tessaya-recognizer listening on {addr}");
    accept_loop(listener, Arc::new(token), jobs, queue);
}

/// Every dictation's undecoded audio, on whichever connection it runs.
type Backlog = Arc<Mutex<Vec<Weak<AtomicUsize>>>>;

fn backlog_ms(backlog: &Backlog) -> usize {
    let mut all = backlog.lock().unwrap();
    all.retain(|w| w.strong_count() > 0);
    all.iter().filter_map(Weak::upgrade).map(|w| w.load(Ordering::SeqCst)).sum::<usize>() / 16
}

fn accept_loop(listener: TcpListener, token: Arc<String>, jobs: Sender<Job>, queue: Arc<AtomicUsize>) {
    let open = Arc::new(AtomicUsize::new(0));
    let backlog = Backlog::default();
    for stream in listener.incoming().flatten() {
        if open.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            open.fetch_sub(1, Ordering::SeqCst);
            continue;
        }
        let (token, jobs, queue, open, backlog) = (token.clone(), jobs.clone(), queue.clone(), open.clone(), backlog.clone());
        std::thread::spawn(move || {
            serve(stream, &token, jobs, queue, backlog);
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
fn serve(stream: TcpStream, token: &str, jobs: Sender<Job>, queue: Arc<AtomicUsize>, backlog: Backlog) {
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
    let Ok(socket) = accept_hdr(stream, check) else { return };
    // Reads wait at most 10 ms, so the words going back are never held up behind one.
    let _ = socket.get_ref().set_read_timeout(Some(Duration::from_millis(10)));
    let socket = Arc::new(Mutex::new(socket));
    let send = {
        let socket = socket.clone();
        move |line: Value| socket.lock().unwrap().send(Message::text(line.to_string())).is_ok()
    };
    let (replies, answers) = channel::<Reply>();
    {
        let send = send.clone();
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
                if !send(line) {
                    return;
                }
            }
        });
    }
    let mut dictation: Option<(SyncSender<Feed>, usize, Arc<AtomicUsize>)> = None;
    let mut heard_at = Instant::now();
    let stop = |dictation: &mut Option<(SyncSender<Feed>, usize, Arc<AtomicUsize>)>, why: &str| {
        if let Some((feed, ..)) = dictation.take() {
            let _ = feed.try_send(Feed::Abort);
        }
        send(json!({"ev": "error", "message": why}));
    };
    loop {
        let message = {
            let mut s = socket.lock().unwrap();
            s.read()
        };
        let message = match message {
            Ok(message) => {
                heard_at = Instant::now();
                message
            }
            Err(tungstenite::Error::Io(e))
                if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) =>
            {
                if dictation.is_some() && heard_at.elapsed() >= SILENCE {
                    stop(&mut dictation, "no audio for 2 s; dictation dropped");
                    break;
                }
                if dictation.is_none() && heard_at.elapsed() >= IDLE {
                    break;
                }
                continue;
            }
            Err(_) => break,
        };
        match message {
            Message::Binary(bytes) => {
                let Some((feed, samples, waiting)) = &mut dictation else { continue };
                *samples += bytes.len() / 2;
                if *samples > MAX_SAMPLES {
                    stop(&mut dictation, "dictation over 120 s; dropped");
                    continue;
                }
                let pcm: Vec<f32> =
                    bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();
                let len = pcm.len();
                waiting.fetch_add(len, Ordering::SeqCst);
                match feed.try_send(Feed::Audio(pcm)) {
                    Ok(()) => {}
                    Err(TrySendError::Full(_)) => {
                        waiting.fetch_sub(len, Ordering::SeqCst);
                        stop(&mut dictation, "recogniser behind; dictation dropped")
                    }
                    Err(TrySendError::Disconnected(_)) => dictation = None,
                }
            }
            Message::Text(text) => {
                let value: Value = serde_json::from_str(text.as_str()).unwrap_or(Value::Null);
                match value["cmd"].as_str() {
                    Some("health") => {
                        let busy = queue.load(Ordering::SeqCst);
                        send(json!({"ev": "health", "queue": busy, "busy": busy > 0, "backlogMs": backlog_ms(&backlog),
                            "rtf": engine::SPEED.recent(), "cpuPct": CPU_PCT.load(Ordering::Relaxed)}));
                    }
                    Some("begin") if dictation.is_some() => {
                        send(json!({"ev": "error", "message": "a dictation is already running on this connection"}));
                    }
                    Some("begin") => {
                        let (feed, audio) = sync_channel(FEED_BOUND);
                        let language = value["language"].as_str().map(str::to_string);
                        let waiting = Arc::new(AtomicUsize::new(0));
                        backlog.lock().unwrap().push(Arc::downgrade(&waiting));
                        queue.fetch_add(1, Ordering::SeqCst);
                        if jobs.send(Job { audio, replies: replies.clone(), language, waiting: waiting.clone() }).is_err() {
                            queue.fetch_sub(1, Ordering::SeqCst);
                            send(json!({"ev": "error", "message": "recogniser stopped"}));
                            break;
                        }
                        dictation = Some((feed, 0, waiting));
                        heard_at = Instant::now();
                    }
                    Some("end") => {
                        if let Some((feed, ..)) = dictation.take() {
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
    // A connection that drops mid-dictation abandons it; the engine moves on.
    if let Some((feed, ..)) = dictation {
        let _ = feed.try_send(Feed::Abort);
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
    fn reports_the_audio_not_yet_decoded_in_each_health_answer() {
        let (addr, jobs) = listen();
        let mut socket = client(&addr, "secret").unwrap();
        socket.send(Message::text(r#"{"cmd":"begin"}"#)).unwrap();
        let job = jobs.recv_timeout(Duration::from_secs(2)).unwrap();
        socket.send(Message::binary(vec![0u8; 32_000])).unwrap(); // 1 s the engine has not taken
        // One connection's frames are handled in order, so the ping sees the audio.
        let mut health = || {
            socket.send(Message::text(r#"{"cmd":"health"}"#)).unwrap();
            next_text(&mut socket)
        };
        let answer = health();
        assert_eq!(answer["backlogMs"], 1_000);
        assert_eq!(answer["queue"], 1);
        assert!(answer["cpuPct"].is_u64());
        // The engine takes it: nothing waits.
        assert!(matches!(job.audio.recv().unwrap(), Feed::Audio(_)));
        job.waiting.fetch_sub(16_000, Ordering::SeqCst);
        assert_eq!(health()["backlogMs"], 0);
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
