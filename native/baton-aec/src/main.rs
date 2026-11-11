//! aec-eval <reference.raw> <mic.raw> <out.raw>: 16 kHz mono i16 little-endian in, the mic with the echo taken out.
//! 10 ms frames, the render frame first, as the sidecar will feed it (docs/baton/BARGE_IN.md).
use sonora::config::EchoCanceller;
use sonora::{AudioProcessing, Config, StreamConfig};
use std::{env, fs};

const FRAME: usize = 160;

fn read(path: &str) -> Vec<i16> {
    fs::read(path)
        .unwrap_or_else(|e| panic!("{path}: {e}"))
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect()
}

fn main() {
    let a: Vec<String> = env::args().collect();
    if a.len() != 4 {
        eprintln!("usage: aec-eval <reference.raw> <mic.raw> <out.raw>");
        std::process::exit(2);
    }
    let (reference, mic) = (read(&a[1]), read(&a[2]));
    let mut apm = AudioProcessing::builder()
        .config(Config { echo_canceller: Some(EchoCanceller::default()), ..Default::default() })
        .capture_config(StreamConfig::new(16_000, 1))
        .render_config(StreamConfig::new(16_000, 1))
        .build();
    let mut out = Vec::with_capacity(mic.len() * 2);
    let mut render_out = [0i16; FRAME];
    let mut capture_out = [0i16; FRAME];
    for (i, m) in mic.chunks_exact(FRAME).enumerate() {
        if let Some(r) = reference.get(i * FRAME..(i + 1) * FRAME) {
            apm.process_render_i16(r, &mut render_out).expect("render");
        }
        apm.process_capture_i16(m, &mut capture_out).expect("capture");
        for s in capture_out {
            out.extend_from_slice(&s.to_le_bytes());
        }
    }
    fs::write(&a[3], out).expect("write");
}
