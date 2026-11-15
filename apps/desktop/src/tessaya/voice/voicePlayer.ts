// @effect-diagnostics globalTimers:off globalDate:off -- audio callbacks run outside the Effect runtime
/**
 * Baton's speech out of a hidden page, so playback is one code path everywhere and there is no
 * process per sentence. Samples are scheduled as they arrive, a little ahead so a slow chunk does
 * not click, and the pill's level is read from the same samples at the moment they sound. The page
 * goes after a short idle, so it never keeps the app alive.
 */
import * as Electron from "electron";

import { createVisemeTrack } from "@t3tools/tessaya-shared/visemes";

import {
  FRAME_MS,
  heardAtMs,
  pcmLevel,
  pcmShape,
  speechFrames,
  wavFormat,
  type AudioClock,
  type VoicePlayer,
  type VoiceShape,
} from "./voiceSpeaker.ts";

const IDLE_CLOSE_MS = 30_000;
const HEADER_BYTES = 256;
/** Each frame's level goes out this far ahead of its sound: her jaw takes about this long to open on it. */
const MOUTH_LEAD_MS = FRAME_MS;
/**
 * Her lips take the shape this much further ahead again (80 ms before the sound in all): a mouth forms a sound before
 * it is heard, and a shape placed on the sound reads as late (the animators' "two frames ahead").
 */
const VISEME_LEAD_MS = 40;

const PLAYER_DOCUMENT = `<!doctype html><meta charset="utf-8"><script>
let ctx=null,gain=null,vol=1,next=0,rate=24000,live=[],done=null;const LEAD=.12;
window.setVolume=(v)=>{vol=v;if(gain)gain.gain.value=v;};
window.open_=async(r)=>{ctx??=new AudioContext();if(!gain){gain=ctx.createGain();gain.gain.value=vol;gain.connect(ctx.destination);}if(ctx.state==='suspended')await ctx.resume();rate=r;next=ctx.currentTime+LEAD;live=[];done=null;};
window.push=(b64)=>{const bin=atob(b64),n=bin.length>>1,buf=ctx.createBuffer(1,n,rate),o=buf.getChannelData(0);
 for(let i=0;i<n;i++){const v=(bin.charCodeAt(i*2)|bin.charCodeAt(i*2+1)<<8)<<16>>16;o[i]=v/32768;}
 const s=ctx.createBufferSource();s.buffer=buf;s.connect(gain);if(next<ctx.currentTime+.02)next=ctx.currentTime+.02;
 s.start(next);const at=next;next+=buf.duration;live.push(s);s.onended=()=>{live=live.filter(x=>x!==s);if(!live.length&&done)done();};
 const t=ctx.getOutputTimestamp();return{at,currentTime:ctx.currentTime,contextTime:t.contextTime||0,performanceTime:t.performanceTime||0,timeOrigin:performance.timeOrigin,now:performance.now(),latency:ctx.outputLatency||ctx.baseLatency||0};};
window.finish=()=>new Promise(r=>{if(!live.length)return r();done=r;});
window.halt=()=>{for(const s of live){try{s.onended=null;s.stop();}catch{}}live=[];done&&done();};
</script>`;

/**
 * Chromium restarts its audio service after a crash, but every AudioContext made before it stays silent. The
 * pages drop theirs so the next sound makes a new one.
 */
export const onAudioServiceGone = (listener: () => void): void => {
  Electron.app.on("child-process-gone", (_event, details) => {
    if (details.serviceName === "audio.mojom.AudioService" || details.name === "Audio Service") {
      listener();
    }
  });
};

/** The share of the voice's volume left while someone may be talking over it. */
const DUCK_LEVEL = 0.25;

export const createVoicePlayer = (
  onLevel: (level: number, shape?: VoiceShape) => void,
  volume: () => number = () => 1,
  /** What is about to sound (16-bit mono at `rate`) and when, for telling his voice from hers (echo guard). */
  onReference?: (pcm: Int16Array, rate: number, soundsAtMs: number) => void,
): VoicePlayer => {
  let ducked = false;
  let win: Electron.BrowserWindow | null = null;
  let ready: Promise<void> = Promise.resolve();
  let idle: ReturnType<typeof setTimeout> | null = null;
  let stamp = 0;

  const close = () => {
    if (win !== null && !win.isDestroyed()) win.destroy();
    win = null;
  };
  const open = () => {
    if (idle !== null) clearTimeout(idle);
    idle = null;
    if (win !== null && !win.isDestroyed()) return win;
    const created = new Electron.BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      webPreferences: { autoplayPolicy: "no-user-gesture-required", backgroundThrottling: false },
    });
    win = created;
    ready = created.loadURL(`data:text/html,${encodeURIComponent(PLAYER_DOCUMENT)}`);
    return created;
  };

  onAudioServiceGone(() => {
    stamp += 1;
    close();
  });

  return {
    play: async (wav, text) => {
      const mine = ++stamp;
      const target = open();
      await ready;
      const run = (code: string): Promise<number> => target.webContents.executeJavaScript(code);
      let head = Buffer.alloc(0);
      let odd = Buffer.alloc(0);
      let opened = false;
      let rate = 24_000;
      let track: ReturnType<typeof createVisemeTrack> | null = null;
      let sent = 0;
      let bytes = 0;
      const pulses = new Set<ReturnType<typeof setTimeout>>();
      try {
        for await (const chunk of wav) {
          if (mine !== stamp || target.isDestroyed()) return true;
          let pcm = chunk;
          if (!opened) {
            head = Buffer.concat([head, chunk]);
            const format = wavFormat(head);
            if (format === null && head.length < HEADER_BYTES) continue;
            if (format === null) return false;
            await run(`window.open_(${format.rate})`);
            await run(
              `window.setVolume(${Math.min(1, Math.max(0.1, volume())) * (ducked ? DUCK_LEVEL : 1)})`,
            );
            rate = format.rate;
            opened = true;
            if (text !== undefined) track = createVisemeTrack(text, rate);
            pcm = head.subarray(format.start);
          }
          const joined = Buffer.concat([odd, pcm]);
          const even = joined.length & ~1;
          odd = joined.subarray(even);
          if (even === 0) continue;
          const samples = joined.subarray(0, even);
          bytes += even;
          const clock: AudioClock = await target.webContents.executeJavaScript(
            `window.push("${samples.toString("base64")}")`,
          );
          const heard = heardAtMs(clock);
          const pcm16 = new Int16Array(
            samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.length),
          );
          onReference?.(pcm16, rate, heard);
          track?.push(pcm16);
          // ms into the sentence this chunk starts at, on the track's clock
          const into = (sent / rate) * 1000 - heard;
          sent += pcm16.length;
          for (const frame of speechFrames(samples, rate, heard)) {
            const pulse = setTimeout(
              () => {
                pulses.delete(pulse);
                const viseme = track?.at(frame.atMs + into + VISEME_LEAD_MS);
                onLevel(pcmLevel(frame.pcm), {
                  ...pcmShape(frame.pcm),
                  ...(viseme === undefined ? {} : { viseme }),
                });
              },
              frame.atMs - MOUTH_LEAD_MS - Date.now(),
            );
            pulses.add(pulse);
          }
        }
        track?.end();
        if (bytes === 0) return false;
        if (!target.isDestroyed()) await run("window.finish()");
        return true;
      } finally {
        for (const pulse of pulses) clearTimeout(pulse);
        onLevel(0);
        idle = setTimeout(close, IDLE_CLOSE_MS);
      }
    },
    duck: (on) => {
      ducked = on;
      if (win !== null && !win.isDestroyed()) {
        const level = Math.min(1, Math.max(0.1, volume())) * (on ? DUCK_LEVEL : 1);
        void win.webContents.executeJavaScript(`window.setVolume(${level})`).catch(() => undefined);
      }
    },
    stop: () => {
      ducked = false;
      stamp += 1;
      if (win !== null && !win.isDestroyed()) {
        void win.webContents.executeJavaScript("window.halt()").catch(() => undefined);
      }
    },
    dispose: close,
  };
};
