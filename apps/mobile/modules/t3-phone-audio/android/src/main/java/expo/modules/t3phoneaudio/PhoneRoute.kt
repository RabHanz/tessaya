package expo.modules.t3phoneaudio

import android.media.AudioDeviceInfo

val headsetTypes = listOf(
  AudioDeviceInfo.TYPE_BLE_HEADSET,
  AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
  AudioDeviceInfo.TYPE_WIRED_HEADSET,
  AudioDeviceInfo.TYPE_USB_HEADSET,
)

fun <T> pickByPriority(devices: List<T>, priority: List<Int>, type: (T) -> Int): T? =
  priority.firstNotNullOfOrNull { wanted -> devices.firstOrNull { type(it) == wanted } }

fun outputKind(type: Int): String = when (type) {
  AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth-hfp"
  AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetooth-a2dp"
  AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER -> "bluetooth-le"
  AudioDeviceInfo.TYPE_WIRED_HEADSET,
  AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
  AudioDeviceInfo.TYPE_USB_HEADSET -> "wired"
  AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
  AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "receiver"
  else -> "other"
}
