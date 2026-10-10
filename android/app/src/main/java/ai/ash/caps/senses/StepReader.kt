package ai.ash.caps.senses

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** The phone's hardware step counter (counts since boot; needs the activity-recognition permission). */
object StepReader {
    fun available(ctx: Context) = ctx.getSystemService(SensorManager::class.java).getDefaultSensor(Sensor.TYPE_STEP_COUNTER) != null

    /** The counter now. Throws [SenseError]. */
    fun read(ctx: Context, timeoutMs: Long = 5_000): StepSample {
        if (!Senses.activityRecognition(ctx)) throw SenseError("forbidden", "the physical-activity permission is not granted to Ash (open the senses setup page)")
        val sm = ctx.getSystemService(SensorManager::class.java)
        val sensor = sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) ?: throw SenseError("unavailable", "this phone has no step counter", "source_unavailable")
        var value = -1L
        val done = CountDownLatch(1)
        val listener = object : SensorEventListener {
            override fun onSensorChanged(e: SensorEvent) { value = e.values[0].toLong(); done.countDown() }
            override fun onAccuracyChanged(s: Sensor?, a: Int) {}
        }
        if (!sm.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_NORMAL)) throw SenseError("unavailable", "the step counter could not be read", "source_unavailable")
        try { done.await(timeoutMs, TimeUnit.MILLISECONDS) } finally { sm.unregisterListener(listener) }
        if (value < 0) throw SenseError("unavailable", "the step counter did not answer within ${timeoutMs / 1000}s")
        return StepSample(System.currentTimeMillis(), value, Senses.bootCount(ctx))
    }
}
