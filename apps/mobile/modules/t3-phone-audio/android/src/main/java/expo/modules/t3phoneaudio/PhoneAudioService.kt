package expo.modules.t3phoneaudio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/** Keeps the process eligible to capture and play while the screen is locked. */
class PhoneAudioService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = notification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val playback = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
      try {
        startForeground(ID, notification, playback or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
      } catch (_: SecurityException) {
        // Microphone type needs RECORD_AUDIO granted; still keep playback alive without it.
        startForeground(ID, notification, playback)
      }
    } else {
      startForeground(ID, notification)
    }
    return START_NOT_STICKY
  }

  private fun notification(): Notification {
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL, "Voice", NotificationManager.IMPORTANCE_LOW)
      )
      Notification.Builder(this, CHANNEL)
    } else {
      @Suppress("DEPRECATION") Notification.Builder(this)
    }
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val content = launch?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
    }
    return builder
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle("Tessaya is listening through this phone")
      .setOngoing(true)
      .setContentIntent(content)
      .build()
  }

  private companion object {
    const val ID = 4107
    const val CHANNEL = "t3-phone-audio"
  }
}
