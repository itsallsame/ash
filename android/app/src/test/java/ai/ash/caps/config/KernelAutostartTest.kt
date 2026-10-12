package ai.ash.caps.config

import ai.ash.caps.config.KernelAutostart.Rom
import ai.ash.host.KernelState
import ai.ash.ui.OnboardingPlan
import ai.ash.ui.OnboardingStep
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KernelAutostartTest {
    @Test fun theItemIsOnMiuiAndColorosPhonesOnly() {
        for (m in listOf("Xiaomi", "Redmi", "POCO", "OPPO", "OnePlus", "realme")) assertTrue(m, KernelAutostart.applies(m))
        for (m in listOf("samsung", "Google", "vivo", "HUAWEI", "motorola", "")) assertFalse(m, KernelAutostart.applies(m))
    }

    @Test fun eachRomHasItsOwnSettingsPages() {
        assertEquals(Rom.MIUI, KernelAutostart.rom("Xiaomi"))
        assertEquals(Rom.COLOROS, KernelAutostart.rom("OPPO"))
        for (rom in Rom.entries) {
            assertTrue(KernelAutostart.pages(rom).isNotEmpty())
            assertTrue(KernelAutostart.guidance(rom).contains("Ash 内核"))
        }
        assertEquals(setOf("com.miui.securitycenter"), KernelAutostart.pages(Rom.MIUI).map { it.first }.toSet())
    }

    @Test fun theGuideShowsTheRowInStepTwoOnceTheKernelIsInstalled() {
        val rows = listOf(OnboardingPlan.Row("kernel_battery_optimization", "granted"), OnboardingPlan.Row("kernel_autostart", "missing"))
        assertEquals(listOf("kernel_battery_optimization", "kernel_autostart"), OnboardingPlan.rows(OnboardingStep.PERMISSIONS, KernelState.BOUND, rows).map { it.item })
        assertEquals(emptyList<String>(), OnboardingPlan.rows(OnboardingStep.PERMISSIONS, KernelState.NOT_INSTALLED, rows).map { it.item })
        assertEquals(OnboardingStep.PERMISSIONS, OnboardingPlan.current(KernelState.BOUND, rows, emptySet()))
        assertEquals(OnboardingStep.DONE, OnboardingPlan.current(KernelState.BOUND, rows.map { it.copy(state = "granted") }, emptySet()))
    }
}
