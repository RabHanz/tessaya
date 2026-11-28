const fs = require("node:fs");
const path = require("node:path");

const { withDangerousMod } = require("expo/config-plugins");

// download.onnxruntime.ai, the host of the trunk onnxruntime-c pod, broke on 21 Nov 2026 (wrong certificate, then 404),
// so the pod comes from a checksum-pinned copy built from Microsoft's NuGet package, at the version the
// onnxruntime-react-native binding is built for (pods/onnxruntime-c.podspec.json; provenance in its release notes).
const MARKER = "# tessaya: onnxruntime-c from a pinned copy";
const LINE = `${MARKER}\n  pod 'onnxruntime-c', :podspec => File.join(__dir__, '..', 'pods', 'onnxruntime-c.podspec.json')\n`;

module.exports = function withIosOnnxruntimePod(config) {
  return withDangerousMod(config, [
    "ios",
    (nextConfig) => {
      const podfilePath = path.join(nextConfig.modRequest.platformProjectRoot, "Podfile");
      const podfile = fs.readFileSync(podfilePath, "utf8");
      if (podfile.includes(MARKER)) return nextConfig;
      const anchor = /^\s*use_expo_modules!.*\n/m;
      if (!anchor.test(podfile))
        throw new Error(
          "Unable to pin onnxruntime-c: use_expo_modules! is missing from the Podfile.",
        );
      fs.writeFileSync(
        podfilePath,
        podfile.replace(anchor, (line) => `${line}${LINE}`),
        "utf8",
      );
      return nextConfig;
    },
  ]);
};
