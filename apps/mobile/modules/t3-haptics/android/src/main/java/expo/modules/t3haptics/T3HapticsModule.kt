package expo.modules.t3haptics

import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Plays an Android rendering (packages/tessaya-shared/src/haptics.ts): Composition primitives where the motor has every
 * one, else a waveform with amplitudes, else plain timings. `hardware()` is what the server renders for.
 */
class T3HapticsModule : Module() {
  private val vibrator: Vibrator?
    get() {
      val ctx = appContext.reactContext ?: return null
      return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        ctx.getSystemService(VibratorManager::class.java)?.defaultVibrator
      } else {
        @Suppress("DEPRECATION")
        ctx.getSystemService(Vibrator::class.java)
      }
    }

  override fun definition() = ModuleDefinition {
    Name("T3Haptics")

    Function("hardware") {
      val v = vibrator
      if (v == null || !v.hasVibrator()) {
        null
      } else {
        mapOf("kind" to "android", "primitives" to primitivesOf(v), "amplitude" to v.hasAmplitudeControl())
      }
    }

    Function("play") { rendering: Map<String, Any?> -> play(rendering) }
  }

  // PRIMITIVE_THUD is API 31, so primitives are offered from 31 on and never on an older motor.
  private fun primitivesOf(v: Vibrator): List<String> =
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      emptyList()
    } else {
      PRIMITIVES.filter { (_, id) -> v.areAllPrimitivesSupported(id) }.map { it.first }
    }

  private fun play(r: Map<String, Any?>) {
    val v = vibrator ?: return
    if (!v.hasVibrator() || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val effect = (try {
      when (r["kind"]) {
        "android-composition" -> composition(r["primitives"])
        "android-waveform" -> {
          val timings = longs(r["timings"])
          val amplitudes = longs(r["amplitudes"]).map { it.toInt().coerceIn(0, 255) }.toIntArray()
          if (timings.isEmpty() || timings.size != amplitudes.size) null
          else VibrationEffect.createWaveform(timings, amplitudes, -1)
        }
        "android-timing" -> longs(r["timings"]).takeIf { it.isNotEmpty() }?.let { VibrationEffect.createWaveform(it, -1) }
        else -> null
      }
    } catch (_: IllegalArgumentException) {
      null
    }) ?: return
    v.vibrate(effect)
  }

  private fun composition(raw: Any?): VibrationEffect? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
    val items = (raw as? List<*>)?.mapNotNull { it as? Map<*, *> } ?: return null
    if (items.isEmpty()) return null
    val c = VibrationEffect.startComposition()
    for (item in items) {
      val id = PRIMITIVES.firstOrNull { it.first == item["primitive"] }?.second ?: return null
      val scale = (item["scale"] as? Number)?.toFloat()?.coerceIn(0f, 1f) ?: return null
      val delay = (item["delay"] as? Number)?.toInt()?.coerceAtLeast(0) ?: 0
      c.addPrimitive(id, scale, delay)
    }
    return c.compose()
  }

  private fun longs(raw: Any?): LongArray =
    (raw as? List<*>)?.mapNotNull { (it as? Number)?.toLong()?.coerceAtLeast(0) }?.toLongArray() ?: LongArray(0)

  private companion object {
    val PRIMITIVES = listOf(
      "CLICK" to VibrationEffect.Composition.PRIMITIVE_CLICK,
      "TICK" to VibrationEffect.Composition.PRIMITIVE_TICK,
      "THUD" to VibrationEffect.Composition.PRIMITIVE_THUD,
      "QUICK_RISE" to VibrationEffect.Composition.PRIMITIVE_QUICK_RISE,
    )
  }
}
