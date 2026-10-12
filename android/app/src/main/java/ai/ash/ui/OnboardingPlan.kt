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
    /** The owner said it is on (「你说已开」) though the system does not show it yet: the guide goes on, and it counts as on. */
    const val SAID = "said"

    /** Step 3: the system's two special accesses. */
    private val SCREEN_ACCESS = listOf("accessibility", "notification_listener")
    /**
     * The phone's debug identity (「后台也能动手」) is asked in its step but never holds it: pairing needs the developer options,
     * which not every owner wants.
     */
    private const val NEVER_HOLDS = "host_shell"
    /** Step 4 (optional by nature: Ash works without the senses). */
    private val SENSES = listOf("location", "location_background", "activity_recognition", "health")

    /** The step an item belongs to; everything else the owner sets is step 2. */
    fun stepOf(item: String): OnboardingStep = when (item) {
        in SCREEN_ACCESS -> OnboardingStep.SCREEN_ACCESS
        in SENSES -> OnboardingStep.SENSES
        else -> OnboardingStep.PERMISSIONS
    }

    /** The rows that belong to [step] now: the kernel's battery exemption and auto-start cannot be set while the kernel is not installed. */
    fun rows(step: OnboardingStep, kernel: KernelState, rows: List<Row>): List<Row> =
        rows.filter { stepOf(it.item) == step && !(it.item in KERNEL_SWITCHES && kernel == KernelState.NOT_INSTALLED) }

    private fun done(row: Row) = row.state == GRANTED || row.state == UNSUPPORTED || row.state == SAID

    fun complete(step: OnboardingStep, kernel: KernelState, rows: List<Row>): Boolean = when (step) {
        OnboardingStep.KERNEL -> kernel == KernelState.BOUND
        OnboardingStep.DONE -> false
        else -> rows(step, kernel, rows).all { done(it) || it.item == NEVER_HOLDS }
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
     * One part of her body, as the checkup groups them (HANDOFF §3; the ids are the ones of [ConsoleActivity.EXTRA_PART]).
     * The guide's dots are one per part, and its closing screen names the parts that stayed off.
     * [items] are the ids of `config.status` (plus the keep-alive switches, see [rows]); the brain's
     * own package and connection are not rows, the guide's brain screen is theirs.
     */
    class Part(val id: String, val title: String, val items: List<String>)

    /**
     * The parts in the checkup's order. Where HANDOFF §3 lists an item it is in that part; the rest are put by meaning:
     * reading notifications is one of her eyes ([eyes]); the calendar is only read so that she can remind ahead, which is no part of an alarm being on time, so it is one of the optional ones ([location]); the alert sound and vibration
     * (not a row of `config.status`, the checkup lists it) is how she calls the owner ([notify]).
     * An item no part lists belongs to the last part ([partOf]).
     */
    val PARTS = listOf(
        Part("brain", "大脑", listOf("kernel_battery_optimization", "kernel_autostart")),
        Part("alarm", "闹钟", listOf("exact_alarm")),
        Part("notify", "叫你", listOf("notifications", "alerts")),
        Part("awake", "在后台醒着", listOf("battery_optimization", "autostart", "recents_lock")),
        Part("eyes", "眼睛和手", listOf("accessibility", "notification_listener", "overlay", "host_shell")),
        Part("files", "照片和文件", listOf("photos", "all_files", "write_settings", "usage_access")),
        Part("location", "位置和健康", listOf("location", "location_background", "activity_recognition", "health", "calendar")),
    )

    /** The part an item belongs to (an item no part lists: the last part). */
    fun partOf(item: String): Part = PARTS.firstOrNull { item in it.items } ?: PARTS.last()

    /** Items of a part that only the checkup lists (they are not rows the guide asks). */
    private val CHECKUP_ONLY = setOf("alerts")

    /** The order the guide goes through the parts: reach the owner first, the optional senses last. */
    private val ASK_PARTS = listOf("notify", "alarm", "awake", "brain", "eyes", "files", "location")

    /** The order the guide asks the items in: by part ([ASK_PARTS]), in the order of each part's list. */
    val ASK_ORDER: List<String> = ASK_PARTS.flatMap { id -> PARTS.first { it.id == id }.items }.filter { it !in CHECKUP_ONLY }

    /** The parts the guide shows dots for: those that have an item to ask or that was asked (as [dots], by part, in [ASK_PARTS] order). */
    fun dotParts(kernel: KernelState, rows: List<Row>, skipped: Set<String>, visited: Collection<String>): List<String> {
        val ids = dots(kernel, rows, skipped, visited).map { partOf(it).id }.toSet()
        return ASK_PARTS.filter { it in ids }
    }

    /** The items that can be asked now, in the order they are asked: the ones the phone cannot have are left out, and so are the kernel's switches while it is not installed. */
    fun asked(kernel: KernelState, rows: List<Row>): List<String> {
        val present = rows.filter { !(it.item in KERNEL_SWITCHES && kernel == KernelState.NOT_INSTALLED) && it.state != UNSUPPORTED }.map { it.item }
        return ASK_ORDER.filter { it in present } + present.filter { it !in ASK_ORDER }
    }

    /** The items still to ask: not granted and not skipped. */
    fun pending(kernel: KernelState, rows: List<Row>, skipped: Set<String>): List<String> {
        val state = rows.associate { it.item to it.state }
        return asked(kernel, rows).filter { item -> state[item] != GRANTED && state[item] != SAID && item !in skipped }
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
        /** The parts that have something off, in the order of the checkup ([PARTS]); at most seven. */
        val offParts: List<Part> get() = PARTS.filter { part -> off.any { (if (it == BRAIN) "brain" else partOf(it).id) == part.id } }
    }

    fun summary(kernel: KernelState, rows: List<Row>): Summary {
        val state = rows.associate { it.item to it.state }
        val items = asked(kernel, rows)
        val off = items.filter { state[it] != GRANTED && state[it] != SAID }
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
