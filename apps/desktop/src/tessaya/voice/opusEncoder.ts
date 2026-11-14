// @effect-diagnostics globalTimers:off
/**
 * PCM to Opus in a WebM container, with nothing new to install: Chromium's own MediaRecorder, in a
 * hidden window. It plays the clip into a recorder at real-time pace, so a clip takes as long to
 * save as it lasted; callers save in the background and one at a time. Not run on this machine's CI:
 * it needs Electron (checked by hand on Windows).
 */
import * as Electron from "electron";

const PAGE = `<!doctype html><meta charset="utf-8"><script>
window.decode = async (base64) => {
  const bin = atob(base64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ctx = new AudioContext({ sampleRate: 16000 });
  const buffer = await ctx.decodeAudioData(bytes.buffer); await ctx.close();
  const f = buffer.getChannelData(0); const out = new Uint8Array(f.length * 2); const view = new DataView(out.buffer);
  for (let i = 0; i < f.length; i++) view.setInt16(2 * i, Math.max(-1, Math.min(1, f[i])) * 32767, true);
  let s = ''; for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
  return btoa(s);
};
window.encode = async (base64, rate) => {
  const bin = atob(base64); const n = bin.length / 2; const f = new Float32Array(n);
  for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v > 32767) v -= 65536; f[i] = v / 32768; }
  const ctx = new AudioContext({ sampleRate: rate });
  const buffer = ctx.createBuffer(1, n, rate); buffer.copyToChannel(f, 0);
  const dest = ctx.createMediaStreamDestination(); const src = ctx.createBufferSource(); src.buffer = buffer; src.connect(dest);
  const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 24000 });
  const parts = []; rec.ondataavailable = (e) => parts.push(e.data);
  const done = new Promise((resolve) => { rec.onstop = resolve; });
  rec.start(); src.start(); src.onended = () => rec.stop(); await done; await ctx.close();
  const blob = new Blob(parts, { type: 'audio/webm' }); const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
</script>`;

export const makeOpusEncoder = () => {
  let window: Electron.BrowserWindow | null = null;
  let ready: Promise<void> = Promise.resolve();
  let queue: Promise<unknown> = Promise.resolve();
  const open = () => {
    if (window !== null && !window.isDestroyed()) return window;
    window = new Electron.BrowserWindow({
      show: false,
      webPreferences: { backgroundThrottling: false, autoplayPolicy: "no-user-gesture-required" },
    });
    ready = window.loadURL(`data:text/html,${encodeURIComponent(PAGE)}`).then(() => undefined);
    return window;
  };
  return {
    /** Mono 16-bit PCM in, a WebM/Opus file out. */
    encode: (pcm: Int16Array, rate = 16_000): Promise<Buffer> => {
      const job = queue.then(async () => {
        const target = open();
        await ready;
        const base64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
        const out = (await target.webContents.executeJavaScript(
          `window.encode(${JSON.stringify(base64)}, ${rate})`,
        )) as string;
        return Buffer.from(out, "base64");
      });
      queue = job.catch(() => undefined);
      return job;
    },
    /** A kept clip back to mono 16 kHz PCM, for recognising it again. */
    decode: (bytes: Uint8Array): Promise<Int16Array> => {
      const job = queue.then(async () => {
        const target = open();
        await ready;
        const out = (await target.webContents.executeJavaScript(
          `window.decode(${JSON.stringify(Buffer.from(bytes).toString("base64"))})`,
        )) as string;
        const raw = Buffer.from(out, "base64");
        return new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
      });
      queue = job.catch(() => undefined);
      return job;
    },
    dispose: () => {
      if (window !== null && !window.isDestroyed()) window.destroy();
      window = null;
    },
  };
};
