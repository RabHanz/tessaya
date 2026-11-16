package expo.modules.t3phoneaudio

/** Regroups arbitrary chunks into exact [frameBytes]-sized frames. */
class PcmFramer(private val frameBytes: Int = 1920) {
  private val frame = ByteArray(frameBytes)
  private var filled = 0

  fun push(data: ByteArray, count: Int, emit: (ByteArray) -> Unit) {
    var offset = 0
    while (offset < count) {
      val take = minOf(frameBytes - filled, count - offset)
      System.arraycopy(data, offset, frame, filled, take)
      filled += take
      offset += take
      if (filled == frameBytes) {
        emit(frame.copyOf())
        filled = 0
      }
    }
  }

  fun reset() {
    filled = 0
  }
}
