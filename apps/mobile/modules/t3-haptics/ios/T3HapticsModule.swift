import CoreHaptics
import ExpoModulesCore

/// Plays a `core-haptics` rendering (packages/tessaya-shared/src/haptics.ts): transients and continuous events with
/// intensity and sharpness, times in ms. expo-haptics cannot hold a purr or set sharpness, so this is its own engine.
public class T3HapticsModule: Module {
  private var engine: CHHapticEngine?

  public func definition() -> ModuleDefinition {
    Name("T3Haptics")

    Function("hardware") { () -> [String: Any]? in
      CHHapticEngine.capabilitiesForHardware().supportsHaptics ? ["kind": "core-haptics"] : nil
    }

    Function("play") { (rendering: [String: Any]) in
      self.play(rendering)
    }

    OnDestroy {
      self.engine?.stop()
      self.engine = nil
    }
  }

  private func play(_ rendering: [String: Any]) {
    guard rendering["kind"] as? String == "core-haptics",
      let raw = rendering["events"] as? [[String: Any]],
      CHHapticEngine.capabilitiesForHardware().supportsHaptics
    else { return }
    let events = raw.compactMap(event)
    guard !events.isEmpty else { return }
    do {
      let engine = try self.engine ?? start()
      try engine.makePlayer(with: CHHapticPattern(events: events, parameters: [])).start(
        atTime: CHHapticTimeImmediate)
    } catch {
      // A stopped or reset engine is made again on the next buzz.
      self.engine = nil
    }
  }

  private func start() throws -> CHHapticEngine {
    let engine = try CHHapticEngine()
    engine.playsHapticsOnly = true
    engine.isAutoShutdownEnabled = true
    engine.stoppedHandler = { [weak self] _ in self?.engine = nil }
    engine.resetHandler = { [weak self] in self?.engine = nil }
    try engine.start()
    self.engine = engine
    return engine
  }

  private func event(_ e: [String: Any]) -> CHHapticEvent? {
    let number = { (key: String) in (e[key] as? NSNumber)?.doubleValue }
    guard let at = number("at"), let intensity = number("intensity"), let sharpness = number("sharpness")
    else { return nil }
    let parameters = [
      CHHapticEventParameter(parameterID: .hapticIntensity, value: Float(intensity)),
      CHHapticEventParameter(parameterID: .hapticSharpness, value: Float(sharpness)),
    ]
    if e["type"] as? String == "continuous", let duration = number("duration") {
      return CHHapticEvent(
        eventType: .hapticContinuous, parameters: parameters, relativeTime: at / 1000,
        duration: duration / 1000)
    }
    return CHHapticEvent(eventType: .hapticTransient, parameters: parameters, relativeTime: at / 1000)
  }
}
