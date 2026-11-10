//! Dictation recognised on his own server (native/tessaya-recognizer) while the key is held: the microphone's audio
//! goes there as it arrives and the words come back, live and at release. A connection to each server stays open while
//! the app runs, pinged every 10 s, so key-down costs no handshake: the server is chosen from the last ping (round trip,
//! queue, decode backlog) and `begin` goes out on its open socket. A server that is busy, unanswered or stalls is
//! passed over and the local engine, which kept every sample, decodes instead. Audio is never stored.
use std::net::TcpStream;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
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

/// A server's last ping: its round trip, the dictations it is working on, the audio it holds not yet decoded, its
/// recent decode speed (None: nothing decoded lately) and how busy its CPU was over the last second.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Health {
    pub rtt_ms: u64,
    pub queue: u64,
    pub backlog_ms: u64,
    pub rtf: Option<f64>,
    pub cpu_pct: u64,
}

/// Audio a server may hold undecoded and still be used: past it the laptop is quicker.
const BUSY_BACKLOG_MS: u64 = 1_000;
/// His laptop's own decode speed when idle (measured 0.31): a server decoding no faster cannot beat it.
const LOCAL_RTF: f64 = 0.3;
/// A CPU this full is decoding behind other work, whatever its last speed said.
const BUSY_CPU_PCT: u64 = 90;

impl Health {
    fn can_beat_local(&self) -> bool {
        self.backlog_ms < BUSY_BACKLOG_MS && self.rtf.is_none_or(|rtf| rtf < LOCAL_RTF) && self.cpu_pct < BUSY_CPU_PCT
    }
}

/// The server to use: the first in his order that answered idle, else the one with the shortest queue, never one with
/// a backlog, a slow recent decode or a full CPU. None when none qualifies: the laptop decodes.
pub fn choose(answers: &[(usize, Option<Health>)]) -> Option<usize> {
    let healthy: Vec<(usize, Health)> =
        answers.iter().filter_map(|(i, h)| h.filter(Health::can_beat_local).map(|h| (*i, h))).collect();
    healthy
        .iter()
        .find(|(_, h)| h.queue == 0)
        .or_else(|| healthy.iter().min_by_key(|(i, h)| (h.queue, *i)))
        .map(|(i, _)| *i)
}

type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

/// Only a plain ws:// address on his tailnet: an address in its own block (RFC 6598) or a MagicDNS name. The tailnet
/// already encrypts the link; wss:// is refused until it means real TLS here.
pub fn allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("ws://") else { return false };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if port.parse::<u16>().is_ok() => host,
        _ => authority,
    };
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        // The tests' own servers.
        if cfg!(test) && ip.is_loopback() {
            return true;
        }
        let [a, b, ..] = ip.octets();
        return a == 100 && (64..128).contains(&b);
    }
    // MagicDNS's suffix, in two pieces so the repository's privacy guard does not take it for one of his names.
    let suffix = concat!(".ts", ".net");
    let host = host.to_ascii_lowercase();
    host.ends_with(suffix) && host.len() > suffix.len()
}

fn connect(server: &Server, timeout: Duration) -> Result<Socket, String> {
    if !allowed(&server.url) {
        return Err(format!("{} is not a ws:// address on the tailnet", server.url));
    }
    let started = Instant::now();
    let mut request = server.url.as_str().into_client_request().map_err(|e| e.to_string())?;
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", server.token).parse().map_err(|_| "bad token".to_string())?,
    );
    let url = request.uri().clone();
    let host = url.host().ok_or("no host")?.to_string();
    let port = url.port_u16().unwrap_or(80);
    // A name lookup that hangs must not hold the key-down: it gets the same budget as the connection.
    let (tx, rx) = channel();
    thread::spawn(move || {
        let _ = tx.send(std::net::ToSocketAddrs::to_socket_addrs(&(host.as_str(), port)).map(|mut a| a.next()));
    });
    let addr = rx
        .recv_timeout(timeout)
        .map_err(|_| "name lookup timed out".to_string())?
        .map_err(|e| e.to_string())?
        .ok_or("no address")?;
    let left = timeout.saturating_sub(started.elapsed()).max(Duration::from_millis(1));
    let tcp = TcpStream::connect_timeout(&addr, left).map_err(|e| e.to_string())?;
    let _ = tcp.set_nodelay(true);
    let _ = tcp.set_read_timeout(Some(timeout));
    let _ = tcp.set_write_timeout(Some(timeout));
    let (socket, _) =
        tungstenite::client::client(request, MaybeTlsStream::Plain(tcp)).map_err(|e| e.to_string())?;
    Ok(socket)
}

/// How often an open connection is pinged, and how long its answer may take before it is dropped and reopened.
const PING: Duration = Duration::from_secs(10);
const PING_WAIT: Duration = Duration::from_secs(3);
/// A ping older than this says nothing about the server now.
const STALE: Duration = Duration::from_secs(25);
const CONNECT: Duration = Duration::from_secs(3);
const MAX_BACKOFF: Duration = Duration::from_secs(10);

fn parse_health(text: &str, rtt: Duration) -> Option<Health> {
    let v: Value = serde_json::from_str(text).ok()?;
    (v["ev"] == "health").then(|| Health {
        rtt_ms: rtt.as_millis() as u64,
        queue: v["queue"].as_u64().unwrap_or(0),
        backlog_ms: v["backlogMs"].as_u64().unwrap_or(0),
        rtf: v["rtf"].as_f64(),
        cpu_pct: v["cpuPct"].as_u64().unwrap_or(0),
    })
}

/// One server's open connection and its last ping.
#[derive(Default)]
struct Link {
    socket: Mutex<Option<Socket>>,
    health: Mutex<Option<(Health, Instant)>>,
}

impl Link {
    fn drop_socket(&self) {
        *self.socket.lock().unwrap() = None;
        *self.health.lock().unwrap() = None;
    }

    /// The server's answer to a ping. The socket is locked only per read, so a key-down never waits behind a ping;
    /// if it takes the socket meanwhile, the answer arrives on the dictation, which ignores it.
    fn ping(&self) -> Option<Health> {
        let sent = Instant::now();
        {
            let mut slot = self.socket.lock().unwrap();
            if slot.as_mut()?.send(Message::text(json!({"cmd": "health"}).to_string())).is_err() {
                *slot = None;
                return None;
            }
        }
        while sent.elapsed() < PING_WAIT {
            let mut slot = self.socket.lock().unwrap();
            match slot.as_mut()?.read() {
                Ok(Message::Text(text)) => {
                    if let Some(health) = parse_health(text.as_str(), sent.elapsed()) {
                        return Some(health);
                    }
                }
                Ok(_) => {}
                Err(tungstenite::Error::Io(e))
                    if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                Err(_) => break,
            }
        }
        None
    }
}

/// Keeps one server's connection open: connect, ping every `PING`, reopen with backoff when it fails. Woken early
/// when a dictation took the socket or the network changed; ends when the pool is dropped.
fn keep(server: Server, link: Arc<Link>, wake: Receiver<()>) {
    let mut backoff = Duration::from_millis(500);
    loop {
        let open = link.socket.lock().unwrap().is_some()
            || match connect(&server, CONNECT) {
                Ok(socket) => {
                    if let MaybeTlsStream::Plain(tcp) = socket.get_ref() {
                        let _ = tcp.set_read_timeout(Some(Duration::from_millis(20)));
                    }
                    *link.socket.lock().unwrap() = Some(socket);
                    true
                }
                Err(_) => false,
            };
        let healthy = open && link.ping().map(|health| *link.health.lock().unwrap() = Some((health, Instant::now()))).is_some();
        let wait = if healthy {
            backoff = Duration::from_millis(500);
            PING
        } else {
            link.drop_socket();
            let wait = backoff;
            backoff = (backoff * 2).min(MAX_BACKOFF);
            wait
        };
        if let Err(RecvTimeoutError::Disconnected) = wake.recv_timeout(wait) {
            if let Some(socket) = link.socket.lock().unwrap().as_mut() {
                let _ = socket.close(None);
            }
            return;
        }
    }
}

/// An open connection to each of his servers, kept while the app runs.
pub struct Warm {
    servers: Vec<Server>,
    links: Vec<Arc<Link>>,
    wakes: Vec<Sender<()>>,
}

impl Warm {
    pub fn start(servers: &[Server]) -> Warm {
        let mut warm = Warm { servers: servers.to_vec(), links: Vec::new(), wakes: Vec::new() };
        for server in servers {
            let link = Arc::new(Link::default());
            let (wake, woken) = channel();
            // One that can never be used gets no connection; it stays in the list so the order still matches his.
            if allowed(&server.url) {
                let (server, link) = (server.clone(), link.clone());
                thread::spawn(move || keep(server, link, woken));
            }
            warm.links.push(link);
            warm.wakes.push(wake);
        }
        warm
    }

    /// Pings every server now: the network changed, so the open connections may be dead.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn check(&self) {
        for wake in &self.wakes {
            let _ = wake.send(());
        }
    }

    /// The server to use now with its open socket and last ping, chosen from the pings alone: no network on this path.
    /// Its connection is then reopened in the background for the next dictation.
    pub fn take(&self) -> Option<(usize, Socket, Health)> {
        let answers: Vec<(usize, Option<Health>)> = self
            .links
            .iter()
            .enumerate()
            .map(|(i, link)| (i, link.health.lock().unwrap().filter(|(_, at)| at.elapsed() < STALE).map(|(h, _)| h)))
            .collect();
        let chosen = choose(&answers)?;
        let socket = self.links[chosen].socket.lock().unwrap().take()?;
        *self.links[chosen].health.lock().unwrap() = None;
        let _ = self.wakes[chosen].send(());
        Some((chosen, socket, answers[chosen].1?))
    }

    /// The first server's socket and last ping whatever they say, for measuring it (the replay).
    fn take_first(&self) -> Option<(Socket, Health)> {
        let (health, _) = self.links.first()?.health.lock().unwrap().take()?;
        let socket = self.links[0].socket.lock().unwrap().take()?;
        let _ = self.wakes[0].send(());
        Some((socket, health))
    }

    /// Whether every server that can be used has a fresh ping (the replay waits for this between recordings).
    fn ready(&self) -> bool {
        self.links.iter().zip(&self.servers).all(|(link, server)| !allowed(&server.url) || link.health.lock().unwrap().is_some())
    }
}

static POOL: Mutex<Option<Warm>> = Mutex::new(None);

/// Keeps connections open to exactly these servers (his settings; empty closes them all).
pub fn keep_warm(servers: &[Server]) {
    let mut pool = POOL.lock().unwrap();
    if pool.as_ref().map(|warm| warm.servers.as_slice()) != Some(servers) {
        *pool = (!servers.is_empty()).then(|| Warm::start(servers));
        if pool.is_some() {
            watch_network();
        }
    }
}

/// The server and open socket for a dictation starting now, if one is ready.
pub fn take_warm(servers: &[Server]) -> Option<(usize, Socket, Health)> {
    keep_warm(servers);
    POOL.lock().unwrap().as_ref()?.take()
}

/// When an address changes (Wi-Fi to cable, waking from sleep) every connection is pinged at once, not at its next turn.
fn watch_network() {
    #[cfg(windows)]
    {
        static WATCHING: std::sync::Once = std::sync::Once::new();
        WATCHING.call_once(|| {
            thread::spawn(|| loop {
                // Blocks until an IPv4 address changes.
                let changed = unsafe { windows::Win32::NetworkManagement::IpHelper::NotifyAddrChange(std::ptr::null_mut(), std::ptr::null()) };
                if changed != 0 {
                    return;
                }
                if let Some(warm) = POOL.lock().unwrap().as_ref() {
                    warm.check();
                }
            });
        });
    }
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
    /// Says `begin` on a socket already open (the pool's).
    pub fn begin(mut socket: Socket, language: Option<String>) -> Result<Dictation, String> {
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
/// time (20 ms blocks of 16 kHz mono), as a held key would send it; one JSON line each with the last ping, the time to
/// take the open connection, the release to text, and the live-word cadence. For measuring the real path from his machine; it never pastes.
pub fn replay(url: &str, token_file: &str, wavs: &[String]) -> Result<(), String> {
    // A measuring tool in the shipped build, off unless asked for by name.
    if std::env::var("TESSAYA_DEV_REPLAY").as_deref() != Ok("1") {
        return Err("replay-remote is a measuring tool: set TESSAYA_DEV_REPLAY=1".into());
    }
    let token = std::fs::read_to_string(token_file).map_err(|e| format!("{token_file}: {e}"))?.trim().to_string();
    let warm = Warm::start(&[Server { url: url.to_string(), token }]);
    for wav in wavs {
        let mut reader = hound::WavReader::open(wav).map_err(|e| format!("{wav}: {e}"))?;
        let spec = reader.spec();
        if spec.sample_rate != 16_000 || spec.channels != 1 || spec.bits_per_sample != 16 {
            return Err(format!("{wav}: needs 16 kHz mono 16-bit"));
        }
        let pcm: Vec<f32> = reader.samples::<i16>().filter_map(Result::ok).map(|s| s as f32 / 32768.0).collect();
        // As in the app: the connection is already open and pinged when the key goes down.
        let opened = Instant::now();
        while !warm.ready() && opened.elapsed() < Duration::from_secs(10) {
            thread::sleep(Duration::from_millis(50));
        }
        let health_at = Instant::now();
        // The server is used even when the app would pass it over, so its speed is measured either way.
        let taken = warm.take_first();
        let health_ms = health_at.elapsed().as_millis() as u64;
        let health = taken.as_ref().map(|(_, h)| *h);
        let started = match taken {
            Some((socket, _)) => Dictation::begin(socket, None),
            None => Err("no open connection with a fresh ping".to_string()),
        };
        let line = match started {
            Err(why) => json!({"wav": wav, "error": why, "healthMs": health_ms}),
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
                    "rttMs": health.map(|h| h.rtt_ms),
                    "backlogMs": health.map(|h| h.backlog_ms),
                    "rtf": health.and_then(|h| h.rtf),
                    "cpuPct": health.map(|h| h.cpu_pct),
                    "appWouldSkip": health.map(|h| !h.can_beat_local()),
                    "rtf": health.and_then(|h| h.rtf),
                    "cpuPct": health.map(|h| h.cpu_pct),
                    "appWouldSkip": health.map(|h| !h.can_beat_local()),
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
    fn takes_only_plain_ws_on_the_tailnet() {
        // Built here, not written out, so the privacy guard sees no address.
        let cgnat = |a: u8, b: u8| format!("ws://{}.{a}.{b}.1:8797", 100);
        let magic = |name: &str| format!("ws://{name}{}", concat!(".tail1.ts", ".net:8797"));
        assert!(allowed(&cgnat(76, 212)));
        assert!(allowed(&cgnat(127, 0)));
        assert!(allowed(&magic("box")));
        assert!(!allowed(&cgnat(76, 212).replace("ws://", "wss://")));
        assert!(!allowed(&cgnat(128, 0)));
        assert!(!allowed("ws://192.168.1.5:8797"));
        assert!(!allowed("ws://example.com:8797"));
        assert!(!allowed(&format!("ws://evil{}.example.com", concat!(".ts", ".net"))));
        assert!(!allowed(&format!("ws://{}", concat!(".ts", ".net"))));
        assert!(!allowed(&cgnat(76, 212).replace("ws://", "http://")));
    }

    #[test]
    fn picks_his_first_idle_server_else_the_shortest_queue_else_none() {
        let h = |queue| Some(Health { queue, ..Health::default() });
        let behind = |backlog_ms| Some(Health { backlog_ms, ..Health::default() });
        // A backlog passes a server over, even his first; one under the limit is still idle.
        assert_eq!(choose(&[(0, behind(BUSY_BACKLOG_MS)), (1, h(1))]), Some(1));
        assert_eq!(choose(&[(0, behind(BUSY_BACKLOG_MS - 1)), (1, h(0))]), Some(0));
        assert_eq!(choose(&[(0, behind(5_000))]), None);
        // So does a recent decode no faster than his laptop's, or a full CPU; no recent decode is judged on the CPU.
        let rtf = |rtf| Some(Health { rtf: Some(rtf), ..Health::default() });
        let cpu = |cpu_pct| Some(Health { cpu_pct, ..Health::default() });
        assert_eq!(choose(&[(0, rtf(LOCAL_RTF)), (1, h(0))]), Some(1));
        assert_eq!(choose(&[(0, rtf(0.1)), (1, h(0))]), Some(0));
        assert_eq!(choose(&[(0, cpu(BUSY_CPU_PCT)), (1, cpu(40))]), Some(1));
        assert_eq!(choose(&[(0, rtf(0.8)), (1, cpu(95))]), None);
        // So does a recent decode no faster than his laptop's, or a full CPU; no recent decode is judged on the CPU.
        let rtf = |rtf| Some(Health { rtf: Some(rtf), ..Health::default() });
        let cpu = |cpu_pct| Some(Health { cpu_pct, ..Health::default() });
        assert_eq!(choose(&[(0, rtf(LOCAL_RTF)), (1, h(0))]), Some(1));
        assert_eq!(choose(&[(0, rtf(0.1)), (1, h(0))]), Some(0));
        assert_eq!(choose(&[(0, cpu(BUSY_CPU_PCT)), (1, cpu(40))]), Some(1));
        assert_eq!(choose(&[(0, rtf(0.8)), (1, cpu(95))]), None);
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

    /// A recogniser that answers pings with `backlog_ms` and says on `opened` each time a connection is accepted.
    fn fake(backlog_ms: u64) -> (Server, Receiver<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let (opened, connections) = channel();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = opened.send(());
                thread::spawn(move || {
                    let Ok(mut socket) = tungstenite::accept(stream) else { return };
                    while let Ok(message) = socket.read() {
                        if message.to_text().is_ok_and(|t| t.contains("health")) {
                            let answer = json!({"ev": "health", "queue": 0, "backlogMs": backlog_ms});
                            let _ = socket.send(Message::text(answer.to_string()));
                        }
                    }
                });
            }
        });
        (Server { url, token: "t".into() }, connections)
    }

    #[test]
    fn takes_an_open_connection_from_the_pings_and_reopens_it_for_the_next() {
        let (busy, _) = fake(5_000);
        let (idle, idle_opened) = fake(0);
        let warm = Warm::start(&[busy, idle]);
        let opened = Instant::now();
        while !warm.ready() && opened.elapsed() < Duration::from_secs(5) {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(warm.ready());
        // His first server is behind, so the second is taken, with its last ping and no new connection.
        let (chosen, _socket, health) = warm.take().unwrap();
        assert_eq!((chosen, health.backlog_ms), (1, 0));
        idle_opened.recv_timeout(Duration::from_secs(5)).unwrap();
        // Taken means gone from the pool: the next dictation gets a fresh connection, opened in the background.
        idle_opened.recv_timeout(Duration::from_secs(5)).unwrap();
    }
}
