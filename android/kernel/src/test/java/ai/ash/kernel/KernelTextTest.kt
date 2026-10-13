package ai.ash.kernel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class KernelTextTest {
    @Test fun everySupervisorStateHasAChineseLine() {
        assertEquals("正在启动", KernelText.forState(KernelState.STARTING))
        assertEquals("正在安装运行环境…", KernelText.forState(KernelState.INSTALLING))
        assertEquals("正在运行", KernelText.forState(KernelState.RUNNING))
        assertEquals("正在重启", KernelText.forState(KernelState.RESTARTING))
        assertEquals("已停止", KernelText.forState(KernelState.STOPPED))
        assertEquals("出错了", KernelText.forState(KernelState.ERROR))
        for (s in KernelState.values()) {
            assertTrue("$s has no CJK text", KernelText.forState(s, "x").any { it.code in 0x4E00..0x9FFF })
        }
    }

    @Test fun errorKeepsTheReasonWhenThereIsOne() {
        assertEquals("出错了：磁盘已满", KernelText.error("磁盘已满"))
        assertEquals("出错了", KernelText.error(null))
        assertEquals("出错了", KernelText.error("  "))
    }

    @Test fun coreMachineWordsBecomeChinese() {
        assertEquals("正在运行", KernelText.fromCore("running", "running"))
        assertEquals("正在运行", KernelText.fromCore("Running", "running"))
        assertEquals("正在运行", KernelText.fromCore("", "running"))
        assertEquals("正在启动", KernelText.fromCore("starting", "starting"))
        assertEquals("运行不稳定", KernelText.fromCore("degraded", "degraded"))
        assertEquals("正在停止", KernelText.fromCore(" ", "stopping"))
    }

    @Test fun coreOwnSentenceIsShownAsItIs() {
        assertEquals("2 个任务在跑", KernelText.fromCore("2 个任务在跑", "running"))
        assertEquals("all fine", KernelText.fromCore("all fine", "running"))
    }

    @Test fun theHostLostNoticeSaysWhatHappenedAndWhatToDo() {
        assertEquals("后台动手断开了", KernelText.HOST_LOST_TITLE)
        assertTrue(KernelText.HOST_LOST_TEXT.contains("USB 插拔"))
        assertTrue(KernelText.HOST_LOST_TEXT.contains("重新接上"))
        assertTrue(KernelText.HOST_LOST_TEXT.contains("仅充电"))
    }
}
