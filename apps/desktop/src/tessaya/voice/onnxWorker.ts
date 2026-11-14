/**
 * The wake and speech-detector ONNX sessions, in their own process. onnxruntime-node loads and runs a model
 * synchronously on the calling thread, which on the main process froze every window (AppHang).
 */
import { serveOnnx, type OnnxReply, type OnnxRequest } from "./onnxHost.ts";

// An Electron utilityProcess gets `parentPort`; a plain Node fork (the main-thread benchmark) gets `process.send`.
const parent = (
  process as {
    parentPort?: {
      on: (event: "message", f: (e: { data: OnnxRequest }) => void) => void;
      postMessage: (m: OnnxReply) => void;
    };
  }
).parentPort;
if (parent !== undefined) {
  const handle = serveOnnx((reply) => parent.postMessage(reply));
  parent.on("message", (e) => handle(e.data));
} else if (process.send !== undefined) {
  const handle = serveOnnx((reply) => process.send?.(reply));
  process.on("message", (m) => handle(m as OnnxRequest));
}
