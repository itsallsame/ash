package ai.ash.ui

import ai.ash.caps.config.KernelAutostart
import ai.ash.host.KernelState

/**
 * The five steps of the first-launch guide (SPEC-05 §9). The guide now asks one thing per screen ([OnboardingPlan.page]);
 * the steps stay as the grouping the rest of the app (the checkup) and the tests know.
 */
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

    /**
     * What one row says: the mark, the name and why the owner would want it, in the owner's words. The English `detail`
     * of `config.status` is for an agent reading it and is not shown here (it repeated the Chinese line beneath it).
     */
    fun rowText(mark: String, name: String, why: String) = if (why.isEmpty()) "$mark $name" else "$mark $name\n$why"

    /** The switches of the kernel package itself. */
    private val KERNEL_SWITCHES = setOf("kernel_battery_optimization", "kernel_autostart")

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

    /** The rows that belong to [step] now: the kernel's battery exemption and auto-start cannot be set while the kernel is not installed. */
    fun rows(step: OnboardingStep, kernel: KernelState, rows: List<Row>): List<Row> =
        rows.filter { stepOf(it.item) == step && !(it.item in KERNEL_SWITCHES && kernel == KernelState.NOT_INSTALLED) }

    private fun done(row: Row) = row.state == GRANTED || row.state == UNSUPPORTED

    fun complete(step: OnboardingStep, kernel: KernelState, rows: List<Row>): Boolean = when (step) {
        OnboardingStep.KERNEL -> kernel == KernelState.BOUND
        OnboardingStep.DONE -> false
        else -> rows(step, kernel, rows).all { done(it) || it.item == RECOVERY_GRANT }
    }

    /** The first step that is not over and not skipped; [OnboardingStep.DONE] when none is left. */
    fun current(kernel: KernelState, rows: List<Row>, skipped: Set<OnboardingStep>): OnboardingStep =
        OnboardingStep.entries.first { it == OnboardingStep.DONE || (it !in skipped && !complete(it, kernel, rows)) }

    // ---- One thing per screen --------------------------------------------------------------------------------------

    /** What a screen of the guide is about. */
    enum class Kind { WELCOME, BRAIN, ITEM, DONE }

    /** One screen of the guide: [item] is set for [Kind.ITEM] only. */
    data class Page(val kind: Kind, val item: String? = null)

    /** The pseudo item for the kernel package on the closing screen (it is not a row of `config.status`). */
    const val BRAIN = "brain"

    /**
     * The order the guide asks in: what matters first, by the part of her body it belongs to (the checkup's groups): reach
     * the owner, wake on time, stay awake in the background, the brain's own switches, eyes and hands, photos and files,
     * and last the optional senses (position, health). An item that is not listed is asked at the end, so none is lost.
     */
    val ASK_ORDER = listOf(
        "notifications", "exact_alarm",
        "battery_optimization", "autostart", "recents_lock",
        "kernel_battery_optimization", "kernel_autostart",
        "accessibility", "notification_listener", "screen_recovery", "overlay", "shizuku",
        "photos", "calendar", "all_files", "write_settings", "usage_access",
        "location", "location_background", "activity_recognition", "health",
    )

    /** The items that can be asked now, in the order they are asked: the ones the phone cannot have are left out, and so are the kernel's switches while it is not installed. */
    fun asked(kernel: KernelState, rows: List<Row>): List<String> {
        val present = rows.filter { !(it.item in KERNEL_SWITCHES && kernel == KernelState.NOT_INSTALLED) && it.state != UNSUPPORTED }.map { it.item }
        return ASK_ORDER.filter { it in present } + present.filter { it !in ASK_ORDER }
    }

    /**
     * The items still to ask: not granted and not skipped. The recovery grant is only asked while the system's two special
     * accesses are not both given (as before, it never holds the guide), and not at all once the owner passed on accessibility.
     */
    fun pending(kernel: KernelState, rows: List<Row>, skipped: Set<String>): List<String> {
        val state = rows.associate { it.item to it.state }
        val accessOpen = SCREEN_ACCESS.any { state[it]?.let { s -> s != GRANTED && s != UNSUPPORTED } == true }
        return asked(kernel, rows).filter { item ->
            state[item] != GRANTED && item !in skipped &&
                (item != RECOVERY_GRANT || (accessOpen && "accessibility" !in skipped))
        }
    }

    /** The screen the guide is on: the kernel while it is not up (and not passed on), then the first item left, then the closing screen. Welcome is the activity's own, before all of these. */
    fun page(kernel: KernelState, rows: List<Row>, kernelSkipped: Boolean, skipped: Set<String>): Page = when {
        kernel != KernelState.BOUND && !kernelSkipped -> Page(Kind.BRAIN)
        else -> pending(kernel, rows, skipped).firstOrNull()?.let { Page(Kind.ITEM, it) } ?: Page(Kind.DONE)
    }

    /** The screens the dots stand for: every item that has been shown or is still to come, in order. */
    fun dots(kernel: KernelState, rows: List<Row>, skipped: Set<String>, visited: Collection<String>): List<String> {
        val left = pending(kernel, rows, skipped).toSet()
        return asked(kernel, rows).filter { it in visited || it in left }
    }

    /** What the closing screen counts: how many are on, and which of the asked ones are not ([BRAIN] first when the kernel is not up). */
    data class Summary(val on: Int, val off: List<String>) {
        val total get() = on + off.size
    }

    fun summary(kernel: KernelState, rows: List<Row>): Summary {
        val state = rows.associate { it.item to it.state }
        val items = asked(kernel, rows)
        val off = items.filter { state[it] != GRANTED }
        val brain = kernel == KernelState.BOUND
        return Summary(items.size - off.size + if (brain) 1 else 0, (if (brain) emptyList() else listOf(BRAIN)) + off)
    }

    /** The kernel installer speaks of 「内核包」; the owner is told of the brain. */
    fun brainWords(raw: String): String = raw.replace("内核包", "大脑的安装包").replace("内核", "大脑")

    /** How long the kernel may take to come up after the system's own question before the guide offers to ask again (ms). */
    const val KERNEL_WAIT_MS = 30_000L

    /**
     * Step 1 on MIUI and ColorOS: the system asks once whether the kernel may be opened the first time the kernel starts, and the
     * kernel does not start on a 「拒绝」. Said before the owner meets the question; null on a phone that does not ask.
     */
    fun kernelPrompt(rom: KernelAutostart.Rom?): String? =
        if (rom == null) null else "装好后系统会问你一次，请选「始终允许」。"

    /** The label of the retry button for the owner who refused the question (shown by [showRefusedRetry]). */
    fun kernelRetryHint(rom: KernelAutostart.Rom?): String? =
        if (rom == null) null else "如果刚才选了拒绝，点这里重试"

    /** Whether the retry button for a refused question shows: on a phone that asks, once the kernel has not come up for [KERNEL_WAIT_MS]. */
    fun showRefusedRetry(rom: KernelAutostart.Rom?, waitedMs: Long): Boolean = rom != null && waitedMs >= KERNEL_WAIT_MS
}
