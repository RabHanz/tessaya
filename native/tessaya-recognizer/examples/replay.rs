//! replay <ws://host:port> <token file> <wav dir> <ids file>: his recordings sent in real time (20 ms blocks of
//! 16 kHz PCM16) as the desktop would, one JSON line per recording: release to text as the client saw it, the gaps
//! between live-word updates, and the text. Measures the whole path, network included.
use std::time::{Duration, Instant};
use tungstenite::client::IntoClientRequest;
use tungstenite::{connect, Message};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let token = std::fs::read_to_string(&a[2]).unwrap().trim().to_string();
    for id in std::fs::read_to_string(&a[4]).unwrap().lines().filter(|l| !l.is_empty()) {
        let Ok(mut reader) = hound::WavReader::open(format!("{}/{id}.wav", a[3])) else { continue };
        let pcm: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
        let mut request = a[1].as_str().into_client_request().unwrap();
        request.headers_mut().insert("authorization", format!("Bearer {token}").parse().unwrap());
        let (mut socket, _) = connect(request).unwrap();
        if let tungstenite::stream::MaybeTlsStream::Plain(s) = socket.get_ref() {
            let _ = s.set_nodelay(true);
            let _ = s.set_read_timeout(Some(Duration::from_millis(5)));
        }
        let t = Instant::now();
        socket.send(Message::text(r#"{"cmd":"health"}"#)).unwrap();
        let health_ms = loop {
            if let Ok(Message::Text(_)) = socket.read() {
                break t.elapsed().as_millis() as u64;
            }
        };
        socket.send(Message::text(r#"{"cmd":"begin"}"#)).unwrap();
        let t0 = Instant::now();
        let mut updates: Vec<u64> = vec![];
        let drain = |socket: &mut tungstenite::WebSocket<_>, updates: &mut Vec<u64>| -> Option<serde_json::Value> {
            loop {
                match socket.read() {
                    Ok(Message::Text(text)) => {
                        let v: serde_json::Value = serde_json::from_str(text.as_str()).unwrap();
                        if v["ev"] == "partial" {
                            updates.push(t0.elapsed().as_millis() as u64);
                        } else if v["ev"] == "text" || v["ev"] == "error" {
                            return Some(v);
                        }
                    }
                    _ => return None,
                }
            }
        };
        for (i, block) in pcm.chunks(320).enumerate() {
            let due = t0 + Duration::from_millis(20 * (i as u64 + 1));
            std::thread::sleep(due.saturating_duration_since(Instant::now()));
            let bytes: Vec<u8> = block.iter().flat_map(|s| s.to_le_bytes()).collect();
            socket.send(Message::binary(bytes)).unwrap();
            let _ = drain(&mut socket, &mut updates);
        }
        socket.send(Message::text(r#"{"cmd":"end"}"#)).unwrap();
        let released = Instant::now();
        let done = loop {
            if let Some(v) = drain(&mut socket, &mut updates) {
                break v;
            }
        };
        let wait = released.elapsed().as_millis() as u64;
        let gaps: Vec<u64> = updates.windows(2).map(|w| w[1] - w[0]).collect();
        println!("{}", serde_json::json!({"id": id, "audio_ms": pcm.len() / 16, "release_wait_ms": wait, "server_release_ms": done["releaseMs"], "health_rtt_ms": health_ms, "reused": done["reused"], "first_update_ms": updates.first(), "update_gaps_ms": gaps, "text": done["text"]}));
        let _ = socket.close(None);
    }
}
