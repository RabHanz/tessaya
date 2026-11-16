import AVFoundation
import ExpoModulesCore

private let frameBytes = 1920
private let wireFormat = AVAudioFormat(
  commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
private let playFormat = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
private let headsetInputs: [AVAudioSession.Port] = [.bluetoothHFP, .headsetMic, .usbAudio]

public class T3PhoneAudioModule: Module {
  private let queue = DispatchQueue(label: "t3.phone-audio")
  private var engine: AVAudioEngine?
  private var player: AVAudioPlayerNode?
  private var running = false
  private var micOn = false
  private var observers: [NSObjectProtocol] = []
  // Touched only by the input tap thread, reset before a new tap is installed.
  private var pending = Data()

  public func definition() -> ModuleDefinition {
    Name("T3PhoneAudio")

    Events("onMic", "onRoute", "onState")

    AsyncFunction("start") { () throws -> [String: Any] in
      try self.queue.sync { try self.begin() }
      return self.route()
    }

    Function("play") { (pcm: Uint8Array) in
      let data = Data(bytes: pcm.rawPointer, count: pcm.byteLength & ~1)
      self.queue.async { self.schedule(data) }
    }

    Function("flush") {
      self.queue.async {
        guard let player = self.player, self.engine?.isRunning == true else { return }
        player.stop()
        player.play()
      }
    }

    AsyncFunction("setMic") { (on: Bool) throws in
      try self.queue.sync { try self.mic(on) }
    }

    AsyncFunction("stop") {
      self.queue.sync { self.end() }
    }

    Function("getRoute") { () -> [String: Any] in
      self.route()
    }

    OnDestroy {
      self.queue.sync { self.end() }
    }
  }

  private func begin() throws {
    guard !running else { return }
    try configureSession()
    try AVAudioSession.sharedInstance().setActive(true)
    running = true
    observe()
    do { try rebuild() } catch {
      end()
      throw error
    }
  }

  private func end() {
    guard running else { return }
    running = false
    micOn = false
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers = []
    teardown()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func mic(_ on: Bool) throws {
    guard running else { throw PhoneAudioException("Call start() before setMic().") }
    guard on != micOn else { return }
    micOn = on
    do {
      try configureSession()
      try rebuild()
    } catch {
      sendEvent("onState", ["state": "error", "message": error.localizedDescription])
      if on {
        micOn = false
        try? configureSession()
        try? rebuild()
      }
      throw error
    }
  }

  // .voiceChat forces HFP on Bluetooth, so it is only used while capturing to keep A2DP quality otherwise.
  private func configureSession() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(
      .playAndRecord, mode: micOn ? .voiceChat : .default,
      options: [.allowBluetooth, .allowBluetoothA2DP, .duckOthers])
    guard micOn else {
      try? session.setPreferredInput(nil)
      return
    }
    let inputs = session.availableInputs ?? []
    if let port = headsetInputs.lazy.compactMap({ type in inputs.first { $0.portType == type } }).first {
      try? session.setPreferredInput(port)
    }
  }

  // A fresh engine each time: touching inputNode enables input, which would pin Bluetooth to HFP.
  private func rebuild() throws {
    teardown()
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: playFormat)
    if micOn { try installTap(on: engine) }
    engine.prepare()
    try engine.start()
    player.play()
    self.engine = engine
    self.player = player
  }

  private func teardown() {
    player?.stop()
    engine?.stop()
    player = nil
    engine = nil
  }

  private func installTap(on engine: AVAudioEngine) throws {
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0,
      let converter = AVAudioConverter(from: format, to: wireFormat)
    else { throw PhoneAudioException("No microphone input is available.") }
    pending.removeAll()
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      self?.capture(buffer, converter)
    }
  }

  private func capture(_ buffer: AVAudioPCMBuffer, _ converter: AVAudioConverter) {
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 16_000 / buffer.format.sampleRate) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: capacity) else { return }
    var fed = false
    var error: NSError?
    _ = converter.convert(to: out, error: &error) { _, status in
      if fed {
        status.pointee = .noDataNow
        return nil
      }
      fed = true
      status.pointee = .haveData
      return buffer
    }
    if let error {
      sendEvent("onState", ["state": "error", "message": error.localizedDescription])
      return
    }
    guard let samples = out.int16ChannelData else { return }
    pending.append(UnsafeBufferPointer(start: samples[0], count: Int(out.frameLength)))
    while pending.count >= frameBytes {
      let frame = pending.prefix(frameBytes)
      pending.removeFirst(frameBytes)
      sendEvent("onMic", ["pcm": frame.base64EncodedString()])
    }
  }

  private func schedule(_ data: Data) {
    guard let player, data.count >= 2,
      let buffer = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(data.count / 2)),
      let out = buffer.floatChannelData?[0]
    else { return }
    buffer.frameLength = buffer.frameCapacity
    data.withUnsafeBytes { raw in
      for i in 0..<Int(buffer.frameLength) {
        out[i] = Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))) / 32768
      }
    }
    player.scheduleBuffer(buffer, completionHandler: nil)
  }

  private func observe() {
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    observers = [
      center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) {
        [weak self] note in
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        let began = raw.flatMap(AVAudioSession.InterruptionType.init) == .began
        self?.queue.async { self?.interrupted(began) }
      },
      center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: nil) {
        [weak self] _ in
        guard let self else { return }
        self.sendEvent("onRoute", self.route())
      },
      center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil) {
        [weak self] note in
        let changed = note.object as? AVAudioEngine
        self?.queue.async {
          guard let self, self.running, changed === self.engine else { return }
          self.restart()
        }
      },
      center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil) {
        [weak self] _ in
        self?.queue.async {
          guard let self, self.running else { return }
          try? self.configureSession()
          try? AVAudioSession.sharedInstance().setActive(true)
          self.restart()
        }
      },
    ]
  }

  private func interrupted(_ began: Bool) {
    guard running else { return }
    if began {
      teardown()
      sendEvent("onState", ["state": "interrupted"])
      return
    }
    do {
      try AVAudioSession.sharedInstance().setActive(true)
      try rebuild()
      sendEvent("onState", ["state": "resumed"])
    } catch {
      sendEvent("onState", ["state": "error", "message": error.localizedDescription])
    }
  }

  private func restart() {
    do { try rebuild() } catch {
      sendEvent("onState", ["state": "error", "message": error.localizedDescription])
    }
  }

  private func route() -> [String: Any] {
    let session = AVAudioSession.sharedInstance()
    let current = session.currentRoute
    let output = current.outputs.first
    let inputs = current.inputs + (session.availableInputs ?? [])
    return [
      "output": output.map { outputKind($0.portType) } ?? "other",
      "name": output.map { $0.portName as Any } ?? NSNull(),
      "headsetMic": inputs.contains { headsetInputs.contains($0.portType) },
    ]
  }
}

private func outputKind(_ port: AVAudioSession.Port) -> String {
  switch port {
  case .bluetoothHFP: return "bluetooth-hfp"
  case .bluetoothA2DP: return "bluetooth-a2dp"
  case .bluetoothLE: return "bluetooth-le"
  case .headphones, .usbAudio: return "wired"
  case .builtInSpeaker: return "speaker"
  case .builtInReceiver: return "receiver"
  default: return "other"
  }
}

private final class PhoneAudioException: GenericException<String> {
  override var reason: String { param }
}
