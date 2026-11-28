package expo.modules.t3phoneaudio

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.KeyEvent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.typedarray.Uint8Array
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

private const val RATE = 16_000
private const val FRAME_BYTES = 1920

class T3PhoneAudioModule : Module() {
  private val lock = Any()
  private val queue = LinkedBlockingQueue<Pair<Int, ByteArray>>()
  private val generation = AtomicInteger()
  @Volatile private var track: AudioTrack? = null
  @Volatile private var recorder: AudioRecord? = null
  private var writer: Thread? = null
  private var reader: Thread? = null
  private var context: Context? = null
  private var focus: AudioFocusRequest? = null
  private var buttons: MediaSession? = null
  private var running = false
  private var micOn = false

  private val audio: AudioManager
    get() = requireNotNull(context ?: appContext.reactContext).getSystemService(AudioManager::class.java)

  private val devices = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = devicesChanged()
    override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = devicesChanged()
  }

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    when (change) {
      AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> emitState("interrupted")
      AudioManager.AUDIOFOCUS_GAIN -> emitState("resumed")
    }
  }

  override fun definition() = ModuleDefinition {
    Name("T3PhoneAudio")

    // Her voice is on the loudspeaker when no headset is connected (a Sleeve on its stand), never the earpiece.
    Constants("speakerDefault" to true)

    Events("onMic", "onRoute", "onState", "onButton")

    AsyncFunction("start") {
      synchronized(lock) { begin() }
      route()
    }

    Function("play") { pcm: Uint8Array ->
      val bytes = ByteArray(pcm.byteLength and 1.inv())
      if (bytes.isNotEmpty()) {
        pcm.read(bytes, 0, bytes.size)
        queue.offer(generation.get() to bytes)
      }
    }

    Function("flush") {
      generation.incrementAndGet()
      queue.clear()
      track?.let(::drain)
      Unit
    }

    AsyncFunction("setMic") { on: Boolean -> synchronized(lock) { mic(on) } }

    AsyncFunction("stop") { synchronized(lock) { end() } }

    Function("getRoute") { route() }

    OnDestroy { synchronized(lock) { end() } }
  }

  private fun begin() {
    if (running) return
    val ctx = requireNotNull(appContext.reactContext).applicationContext
    context = ctx
    running = true
    try {
      val intent = Intent(ctx, PhoneAudioService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent) else ctx.startService(intent)
    } catch (error: Exception) {
      emitState("error", "Background audio is unavailable: ${error.message}")
    }
    requestFocus()
    audio.registerAudioDeviceCallback(devices, Handler(Looper.getMainLooper()))
    track = newTrack(AudioAttributes.USAGE_MEDIA)
    writer = thread(name = "t3-phone-audio-play") { writeLoop() }
    buttons = buttonSession(ctx)
  }

  /** The headset's button: Android sends it to the media session that played last, which her replies make this one. */
  private fun buttonSession(ctx: Context): MediaSession? = try {
    MediaSession(ctx, "TessayaPhoneRoute").apply {
      setCallback(
        object : MediaSession.Callback() {
          override fun onMediaButtonEvent(intent: Intent): Boolean {
            val key = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
              intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
            } else {
              @Suppress("DEPRECATION")
              intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
            }
            if (key == null || key.keyCode !in BUTTON_KEYS) return super.onMediaButtonEvent(intent)
            if (key.action == KeyEvent.ACTION_UP && key.repeatCount == 0) {
              sendEvent("onButton", mapOf("button" to "play-pause"))
            }
            return true
          }
        },
        Handler(Looper.getMainLooper()),
      )
      setPlaybackState(
        PlaybackState.Builder()
          .setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE)
          .setState(PlaybackState.STATE_PAUSED, 0, 1f)
          .build(),
      )
      isActive = true
    }
  } catch (error: Exception) {
    emitState("error", "The headset button is unavailable: ${error.message}")
    null
  }

  private fun end() {
    if (!running) return
    running = false
    buttons?.release()
    buttons = null
    if (micOn) stopMic()
    audio.unregisterAudioDeviceCallback(devices)
    abandonFocus()
    writer?.interrupt()
    writer = null
    queue.clear()
    track?.let(::release)
    track = null
    context?.let { it.stopService(Intent(it, PhoneAudioService::class.java)) }
    context = null
  }

  private fun mic(on: Boolean) {
    check(running) { "Call start() before setMic()." }
    if (on == micOn) return
    if (!on) {
      stopMic()
      emitRoute()
      return
    }
    micOn = true
    audio.mode = AudioManager.MODE_IN_COMMUNICATION
    routeToHeadset()
    swapTrack(AudioAttributes.USAGE_VOICE_COMMUNICATION)
    try {
      startCapture()
    } catch (error: Exception) {
      emitState("error", error.message ?: "The microphone could not be opened.")
      stopMic()
      throw error
    }
    emitRoute()
  }

  @Suppress("DEPRECATION")
  private fun stopMic() {
    micOn = false
    stopCapture()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      audio.clearCommunicationDevice()
    } else {
      audio.isBluetoothScoOn = false
      audio.stopBluetoothSco()
      audio.isSpeakerphoneOn = false
    }
    audio.mode = AudioManager.MODE_NORMAL
    swapTrack(AudioAttributes.USAGE_MEDIA)
  }

  @Suppress("DEPRECATION")
  private fun routeToHeadset() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val device =
        pickByPriority(audio.availableCommunicationDevices, headsetTypes) { it.type }
          ?: audio.availableCommunicationDevices.firstOrNull {
            it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
          }
      device?.let { audio.setCommunicationDevice(it) }
    } else {
      // no headset to take the call audio: the loudspeaker, not the earpiece
      audio.isSpeakerphoneOn = !audio.isBluetoothScoAvailableOffCall
      if (audio.isBluetoothScoAvailableOffCall) {
        audio.startBluetoothSco()
        audio.isBluetoothScoOn = true
      }
    }
  }

  private fun devicesChanged() {
    synchronized(lock) { if (micOn) routeToHeadset() }
    emitRoute()
  }

  @SuppressLint("MissingPermission")
  private fun startCapture() {
    val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    val record = AudioRecord(
      MediaRecorder.AudioSource.VOICE_COMMUNICATION,
      RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
      maxOf(min, FRAME_BYTES * 4),
    )
    if (record.state != AudioRecord.STATE_INITIALIZED) {
      record.release()
      throw IllegalStateException("The microphone could not be opened.")
    }
    record.startRecording()
    recorder = record
    val framer = PcmFramer(FRAME_BYTES)
    reader = thread(name = "t3-phone-audio-mic") {
      val buffer = ByteArray(FRAME_BYTES)
      while (recorder === record) {
        val count = record.read(buffer, 0, buffer.size)
        if (count < 0) {
          if (recorder === record) emitState("error", "Microphone read failed ($count).")
          break
        }
        framer.push(buffer, count) {
          sendEvent("onMic", mapOf("pcm" to Base64.encodeToString(it, Base64.NO_WRAP)))
        }
      }
    }
  }

  private fun stopCapture() {
    val record = recorder ?: return
    recorder = null
    try {
      record.stop()
    } catch (_: IllegalStateException) {
    }
    reader?.join(500)
    reader = null
    record.release()
  }

  private fun newTrack(usage: Int): AudioTrack {
    val min = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
    return AudioTrack.Builder()
      .setAudioAttributes(attributes(usage))
      .setAudioFormat(
        AudioFormat.Builder()
          .setSampleRate(RATE)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .build()
      )
      .setTransferMode(AudioTrack.MODE_STREAM)
      .setBufferSizeInBytes(maxOf(min * 2, FRAME_BYTES * 4))
      .build()
      .also { it.play() }
  }

  // Voice-communication usage follows the communication device; media usage keeps A2DP quality.
  private fun swapTrack(usage: Int) {
    val old = track
    track = newTrack(usage)
    old?.let(::release)
  }

  private fun writeLoop() {
    while (true) {
      val (gen, chunk) = try {
        queue.take()
      } catch (_: InterruptedException) {
        return
      }
      var offset = 0
      while (offset < chunk.size && gen == generation.get()) {
        val current = track ?: break
        val written = try {
          current.write(chunk, offset, chunk.size - offset)
        } catch (_: IllegalStateException) {
          -1
        }
        if (written > 0) offset += written else if (current === track) break
      }
    }
  }

  private fun drain(track: AudioTrack) {
    try {
      track.pause()
      track.flush()
      track.play()
    } catch (_: IllegalStateException) {
    }
  }

  private fun release(track: AudioTrack) {
    try {
      track.pause()
      track.flush()
    } catch (_: IllegalStateException) {
    }
    track.release()
  }

  private fun attributes(usage: Int) = AudioAttributes.Builder()
    .setUsage(usage)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()

  @Suppress("DEPRECATION")
  private fun requestFocus() {
    val gain = AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val request = AudioFocusRequest.Builder(gain)
        .setAudioAttributes(attributes(AudioAttributes.USAGE_MEDIA))
        .setOnAudioFocusChangeListener(focusListener)
        .build()
      audio.requestAudioFocus(request)
      focus = request
    } else {
      audio.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, gain)
    }
  }

  @Suppress("DEPRECATION")
  private fun abandonFocus() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focus?.let(audio::abandonAudioFocusRequest)
      focus = null
    } else {
      audio.abandonAudioFocus(focusListener)
    }
  }

  private fun route(): Map<String, Any?> {
    val audio = audio
    val output = if (micOn && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      audio.communicationDevice
    } else {
      track?.routedDevice ?: pickByPriority(
        audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList(),
        mediaOutputs,
      ) { it.type }
    }
    val inputs = audio.getDevices(AudioManager.GET_DEVICES_INPUTS)
    return mapOf(
      "output" to (output?.let { outputKind(it.type) } ?: "other"),
      "name" to output?.productName?.toString(),
      "headsetMic" to inputs.any { it.type in headsetTypes },
    )
  }

  private fun emitRoute() = sendEvent("onRoute", route())

  private fun emitState(state: String, message: String? = null) =
    sendEvent("onState", if (message == null) mapOf("state" to state) else mapOf("state" to state, "message" to message))
}

private val mediaOutputs = listOf(
  AudioDeviceInfo.TYPE_BLE_HEADSET,
  AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
  AudioDeviceInfo.TYPE_WIRED_HEADSET,
  AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
  AudioDeviceInfo.TYPE_USB_HEADSET,
  AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
)

private val BUTTON_KEYS = setOf(
  KeyEvent.KEYCODE_HEADSETHOOK,
  KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
  KeyEvent.KEYCODE_MEDIA_PLAY,
  KeyEvent.KEYCODE_MEDIA_PAUSE,
)
