package ai.ash.ui

import ai.ash.host.KernelState

/** The five steps of the first-launch guide (SPEC-05 §9). */
enum class OnboardingStep { KERNEL, PERMISSIONS, SCREEN_ACCESS, SENSES, DONE }

/**
 * Which step the guide is on. Pure: the state of the kernel package and the items `config.status` reports (plus the
 * keep-alive switches and the accessibility recovery grant, which the guide lists next to them) decide, together
 * with the steps the owner skipped. A step is over when everything in it is granted (or the phone cannot have it);
 * the guide then goes on by itself, and a skipped step is not shown again.
 */
object OnboardingPlan {
    /** One thing the owner can set: [state] is one of `granted`, `missing`, `unsupported` (the words of `config.status`). */
    data class Row(val item: String, val state: String)

    private const val GRANTED = "granted"
    private const val UNSUPPORTED = "unsupported"

    /** Step 3: the system's two special accesses. */
    private val SCREEN_ACCESS = listOf("accessibility", "notification_listener")
    /**
     * The grant that lets Ash bring the accessibility service back after an upgrade. It is shown in step 3 but never holds
     * the step: an ordinary owner cannot give it (it takes a computer or Shizuku).
     */
    private const val RECOVERY_GRANT = "screen_recovery"
    /** Step 4 (optional by nature: Ash works without the senses). */
    private val SENSES = listOf("location", "location_background", "activity_recognition", "health")

    /** The step an item belongs to; everything else the owner sets is step 2. */
    fun stepOf(item: String): OnboardingStep = when (item) {
        in SCREEN_ACCESS, RECOVERY_GRANT -> OnboardingStep.SCREEN_ACCESS
        in SENSES -> OnboardingStep.SENSES
        else -> OnboardingStep.PERMISSIONS
    }

    /** The rows that belong to [step] now: the kernel's battery exemption cannot be set while the kernel is not installed. */
    fun rows(step: OnboardingStep, kernel: KernelState, rows: List<Row>): List<Row> =
        rows.filter { stepOf(it.item) == step && !(it.item == "kernel_battery_optimization" && kernel == KernelState.NOT_INSTALLED) }

    private fun done(row: Row) = row.state == GRANTED || row.state == UNSUPPORTED

    fun complete(step: OnboardingStep, kernel: KernelState, rows: List<Row>): Boolean = when (step) {
        OnboardingStep.KERNEL -> kernel == KernelState.BOUND
        OnboardingStep.DONE -> false
        else -> rows(step, kernel, rows).all { done(it) || it.item == RECOVERY_GRANT }
    }

    /** The first step that is not over and not skipped; [OnboardingStep.DONE] when none is left. */
    fun current(kernel: KernelState, rows: List<Row>, skipped: Set<OnboardingStep>): OnboardingStep =
        OnboardingStep.entries.first { it == OnboardingStep.DONE || (it !in skipped && !complete(it, kernel, rows)) }
}
