package ai.ash.host

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KernelInstallerTest {
    private val a = byteArrayOf(1, 2, 3)
    private val b = byteArrayOf(4, 5, 6)

    @Test fun samePackageSignersAreEqualWhateverTheOrder() {
        assertTrue(KernelInstaller.sameSigners(listOf(a, b), listOf(b.copyOf(), a.copyOf())))
    }

    @Test fun anotherOrMissingSignerIsNotTheSame() {
        assertFalse(KernelInstaller.sameSigners(listOf(a), listOf(b)))
        assertFalse(KernelInstaller.sameSigners(listOf(a), listOf(a, b)))
        assertFalse(KernelInstaller.sameSigners(emptyList(), emptyList()))
    }
}
