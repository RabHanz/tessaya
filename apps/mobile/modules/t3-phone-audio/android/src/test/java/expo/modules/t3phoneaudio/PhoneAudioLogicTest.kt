package expo.modules.t3phoneaudio

import android.media.AudioDeviceInfo
import java.io.ByteArrayOutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PhoneAudioLogicTest {
  @Test fun framerEmitsExactFramesFromArbitraryChunksAndHoldsTheTail() {
    val source = ByteArray(1920 * 3 + 700) { (it % 251).toByte() }
    val framer = PcmFramer(1920)
    val frames = mutableListOf<ByteArray>()
    var offset = 0
    for (size in generateSequence(1) { it * 3 + 7 }) {
      if (offset >= source.size) break
      val count = minOf(size, source.size - offset)
      val chunk = ByteArray(count + 5)
      System.arraycopy(source, offset, chunk, 0, count)
      framer.push(chunk, count) { frames += it }
      offset += count
    }
    assertEquals(3, frames.size)
    frames.forEach { assertEquals(1920, it.size) }
    val joined = ByteArrayOutputStream().apply { frames.forEach(::write) }.toByteArray()
    assertArrayEquals(source.copyOf(1920 * 3), joined)

    framer.reset()
    framer.push(ByteArray(1919), 1919) { frames += it }
    assertEquals(3, frames.size)
  }

  @Test fun communicationDevicePickFollowsHeadsetPriority() {
    val type: (Int) -> Int = { it }
    val speaker = AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
    val earpiece = AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
    val sco = AudioDeviceInfo.TYPE_BLUETOOTH_SCO
    val wired = AudioDeviceInfo.TYPE_WIRED_HEADSET
    val ble = AudioDeviceInfo.TYPE_BLE_HEADSET
    assertEquals(sco, pickByPriority(listOf(speaker, wired, sco), headsetTypes, type))
    assertEquals(ble, pickByPriority(listOf(sco, ble, wired), headsetTypes, type))
    assertEquals(wired, pickByPriority(listOf(earpiece, wired), headsetTypes, type))
    assertNull(pickByPriority(listOf(speaker, earpiece), headsetTypes, type))
  }
}
