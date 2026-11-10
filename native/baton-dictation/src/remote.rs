//! Dictation recognised on his own server (native/tessaya-recognizer) while the key is held: the microphone's audio
//! goes there as it arrives and the words come back, live and at release. The server is picked at key-down by a health
//! check (round trip and queue depth); one that does not answer in time, or stalls, is dropped and the local engine,
//! which kept every sample, decodes instead. Audio travels only inside the tailnet connection and is never stored.
use std::net::TcpStream;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

/// One recogniser he set up: its WebSocket address on the tailnet and its token.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
pub struct Server {
    pub url: String,
    pub token: String,
}

/// What the server said about a dictation.
#[derive(Debug, PartialEq)]
pub enum Event {
    Partial { text: String, pause: bool },
    Text { text: String, infer_ms: u64, reused: bool },
    /// The connection failed or the server reported an error: the local engine takes over.
    Failed(String),
}

/// A server's health at key-down: its round trip and how many dictations it is already working on.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Health {
    pub rtt_ms: u64,
    pub queue: u64,
}

/// The server to use: the first in his order that answered healthy and idle, else the one with the shortest queue.
/// None when none answered: the laptop decodes.
pub fn choose(answers: &[(usize, Option<Health>)]) -> Option<usize> {
    let healthy: Vec<(usize, Health)> = answers.iter().filter_map(|(i, h)| h.map(|h| (*i, h))).collect();
    healthy
        .iter()
        .find(|(_, h)| h.queue == 0)
        .or_else(|| healthy.iter().min_by_key(|(i, h)| (h.queue, *i)))
        .map(|(i, _)| *i)
}

type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

fn connect(server: &Server, timeout: Duration) -> Result<Socket, String> {
    let mut request = server.url.as_str().into_client_request().map_err(|e| e.to_string())?;
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", server.token).parse().map_err(|_| "bad token".to_string())?,
    );
    let url = request.uri().clone();
    let host = url.host().ok_or("no host")?;
    let port = url.port_u16().unwrap_or(80);
    let addr = std::net::ToSocketAddrs::to_socket_addrs(&(host, port))
        .map_err(|e| e.to_string())?
        .next()
        .ok_or("no address")?;
    let tcp = TcpStream::connect_timeout(&addr, timeout).map_err(|e| e.to_string())?;
    let _ = tcp.set_nodelay(true);
    let _ = tcp.set_read_timeout(Some(timeout));
    let (socket, _) =
        tungstenite::client::client(request, MaybeTlsStream::Plain(tcp)).map_err(|e| e.to_string())?;
    Ok(socket)
}

/// A health check against one server, within `timeout` (connect and answer together).
pub fn health(server: &Server, timeout: Duration) -> Option<Health> {
    let started = Instant::now();
    let mut socket = connect(server, timeout).ok()?;
    socket.send(Message::text(json!({"cmd": "health"}).to_string())).ok()?;
    while started.elapsed() < timeout {
        if let Ok(Message::Text(text)) = socket.read() {
            let v: Value = serde_json::from_str(text.as_str()).ok()?;
            if v["ev"] == "health" {
                let _ = socket.close(None);
                return Some(Health { rtt_ms: started.elapsed().as_millis() as u64, queue: v["queue"].as_u64().unwrap_or(0) });
            }
        }
    }
    None
}

/// Checks every server at once and returns the index to use, within `timeout` overall.
pub fn pick(servers: &[Server], timeout: Duration) -> Option<usize> {
    let (tx, rx) = channel();
    for (i, server) in servers.iter().cloned().enumerate() {
        let tx = tx.clone();
        thread::spawn(move || {
            let _ = tx.send((i, health(&server, timeout)));
        });
    }
    drop(tx);
    let deadline = Instant::now() + timeout;
    let mut answers = Vec::new();
    while answers.len() < servers.len() {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(answer) => answers.push(answer),
            Err(_) => break,
        }
    }
    // His first healthy, idle server wins, so the answers are judged in his order, not by who answered first.
    answers.sort_by_key(|(i, _)| *i);
    choose(&answers)
}

enum Out {
    Audio(Vec<u8>),
    End,
}

/// One dictation on a server: audio in as it arrives, events out on `events`.
pub struct Dictation {
    out: Sender<Out>,
    pub events: Receiver<Event>,
}

impl Dictation {
    /// Opens the connection and says `begin`; the socket then lives on its own thread.
    pub fn start(server: &Server, language: Option<String>, timeout: Duration) -> Result<Dictation, String> {
        let mut socket = connect(server, timeout)?;
        socket.send(Message::text(json!({"cmd": "begin", "language": language}).to_string())).map_err(|e| e.to_string())?;
        if let MaybeTlsStream::Plain(tcp) = socket.get_ref() {
            // Short reads, so audio going out is never held up waiting for words coming in.
            let _ = tcp.set_read_timeout(Some(Duration::from_millis(5)));
        }
        let (out, outgoing) = channel::<Out>();
        let (events_tx, events) = channel::<Event>();
        thread::spawn(move || pump(socket, outgoing, events_tx));
        Ok(Dictation { out, events })
    }

    /// 16 kHz mono samples, sent as PCM16 LE.
    pub fn audio(&self, pcm: &[f32]) {
        let bytes: Vec<u8> = pcm.iter().flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()).collect();
        let _ = self.out.send(Out::Audio(bytes));
    }

    /// The release.
    pub fn end(&self) {
        let _ = self.out.send(Out::End);
    }

    /// Waits for the text after `end`, at most `limit`; None means it failed or was too slow.
    pub fn text(&self, limit: Duration, mut partial: impl FnMut(&str, bool)) -> Result<(String, u64, bool), String> {
        let deadline = Instant::now() + limit;
        loop {
            match self.events.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(Event::Partial { text, pause }) => partial(&text, pause),
                Ok(Event::Text { text, infer_ms, reused }) => return Ok((text, infer_ms, reused)),
                Ok(Event::Failed(why)) => return Err(why),
                Err(RecvTimeoutError::Timeout) => return Err("timed out".into()),
                Err(RecvTimeoutError::Disconnected) => return Err("closed".into()),
            }
        }
    }
}

fn pump(mut socket: Socket, outgoing: Receiver<Out>, events: Sender<Event>) {
    let fail = |events: &Sender<Event>, why: String| {
        let _ = events.send(Event::Failed(why));
    };
    let mut ended = false;
    loop {
        // Everything waiting goes out first.
        loop {
            match outgoing.try_recv() {
                Ok(Out::Audio(bytes)) => {
                    if let Err(e) = socket.send(Message::binary(bytes)) {
                        return fail(&events, e.to_string());
                    }
                }
                Ok(Out::End) => {
                    ended = true;
                    if let Err(e) = socket.send(Message::text(json!({"cmd": "end"}).to_string())) {
                        return fail(&events, e.to_string());
                    }
                }
                // The dictation was dropped (cancelled, or the laptop took over): the connection goes with it.
                Err(std::sync::mpsc::TryRecvError::Disconnected) if !ended => {
                    let _ = socket.close(None);
                    return;
                }
                Err(_) => break,
            }
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                let v: Value = serde_json::from_str(text.as_str()).unwrap_or(Value::Null);
                let event = match v["ev"].as_str() {
                    Some("partial") => Event::Partial {
                        text: v["text"].as_str().unwrap_or("").to_string(),
                        pause: v["pause"].as_bool().unwrap_or(false),
                    },
                    Some("text") => Event::Text {
                        text: v["text"].as_str().unwrap_or("").to_string(),
                        infer_ms: v["inferMs"].as_u64().unwrap_or(0),
                        reused: v["reused"].as_bool().unwrap_or(false),
                    },
                    Some("error") => Event::Failed(v["message"].as_str().unwrap_or("error").to_string()),
                    _ => continue,
                };
                let done = matches!(event, Event::Text { .. } | Event::Failed(_));
                if events.send(event).is_err() || done {
                    let _ = socket.close(None);
                    return;
                }
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(e) => return fail(&events, e.to_string()),
        }
    }
}

/// `tessaya-voice replay-remote <url> <token file> <wav>...`: each recording through this client to his server in real
/// time (20 ms blocks of 16 kHz mono), as a held key would send it; one JSON line each with the health check, the
/// release to text, and the live-word cadence. For measuring the real path from his machine; it never pastes.
pub fn replay(url: &str, token_file: &str, wavs: &[String]) -> Result<(), String> {
    let token = std::fs::read_to_string(token_file).map_err(|e| format!("{token_file}: {e}"))?.trim().to_string();
    let server = Server { url: url.to_string(), token };
    for wav in wavs {
        let mut reader = hound::WavReader::open(wav).map_err(|e| format!("{wav}: {e}"))?;
        let spec = reader.spec();
        if spec.sample_rate != 16_000 || spec.channels != 1 || spec.bits_per_sample != 16 {
            return Err(format!("{wav}: needs 16 kHz mono 16-bit"));
        }
        let pcm: Vec<f32> = reader.samples::<i16>().filter_map(Result::ok).map(|s| s as f32 / 32768.0).collect();
        let health_at = Instant::now();
        let health = health(&server, Duration::from_millis(400));
        let health_ms = health_at.elapsed().as_millis() as u64;
        let line = match Dictation::start(&server, None, Duration::from_millis(400)) {
            Err(why) => json!({"wav": wav, "error": why, "healthMs": health_ms, "health": health.map(|h| h.queue)}),
            Ok(dictation) => {
                let t0 = Instant::now();
                let mut updates: Vec<u64> = Vec::new();
                let mut failed: Option<String> = None;
                for (i, block) in pcm.chunks(320).enumerate() {
                    thread::sleep((t0 + Duration::from_millis(20 * (i as u64 + 1))).saturating_duration_since(Instant::now()));
                    dictation.audio(block);
                    while let Ok(event) = dictation.events.try_recv() {
                        match event {
                            Event::Partial { .. } => updates.push(t0.elapsed().as_millis() as u64),
                            Event::Failed(why) => failed = Some(why),
                            Event::Text { .. } => {}
                        }
                    }
                }
                dictation.end();
                let released = Instant::now();
                let result = dictation.text(Duration::from_secs(30), |_, _| updates.push(t0.elapsed().as_millis() as u64));
                let gaps: Vec<u64> = updates.windows(2).map(|w| w[1] - w[0]).collect();
                json!({
                    "wav": wav,
                    "audioMs": pcm.len() / 16,
                    "healthMs": health_ms,
                    "queue": health.map(|h| h.queue),
                    "releaseToTextMs": released.elapsed().as_millis() as u64,
                    "firstUpdateMs": updates.first(),
                    "updateGapsMs": gaps,
                    "reused": result.as_ref().map(|r| r.2).ok(),
                    "error": failed.or(result.as_ref().err().cloned()),
                    "chars": result.map(|r| r.0.len()).unwrap_or(0),
                })
            }
        };
        println!("{line}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_his_first_idle_server_else_the_shortest_queue_else_none() {
        let h = |queue| Some(Health { rtt_ms: 5, queue });
        // His first answered but is busy; the second is idle.
        assert_eq!(choose(&[(0, h(1)), (1, h(0))]), Some(1));
        // Both idle: his order wins.
        assert_eq!(choose(&[(0, h(0)), (1, h(0))]), Some(0));
        // Both busy: the shorter queue.
        assert_eq!(choose(&[(0, h(2)), (1, h(1))]), Some(1));
        // The first did not answer at all.
        assert_eq!(choose(&[(0, None), (1, h(0))]), Some(1));
        assert_eq!(choose(&[(0, None), (1, None)]), None);
        assert_eq!(choose(&[]), None);
    }
}
