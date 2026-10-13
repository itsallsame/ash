package ai.ash.ui.transport
import org.junit.Test
import org.junit.Assert.*
import java.net.URL
import java.net.SocketTimeoutException
class ResultFileTimeoutTest {
    private fun request(method: String, path: String) = CoreHttpRequest(URL("http://127.0.0.1:4700$path"), method, emptyMap(), null, false)
    @Test fun onlyFixedSnapshotHasItsBoundedOperationTimeout() {
        assertEquals(35000, fixedCoreReadTimeout(request("POST", "/api/collaboration/result-files/native/snapshot")))
        for(r in listOf(request("GET", "/api/collaboration/result-files/native/snapshot"), request("POST", "/api/send"), request("POST", "/api/collaboration/result-files/native/check"), request("POST", "/api/collaboration/result-files/native/snapshot?timeout=300000"))) assertEquals(10000, fixedCoreReadTimeout(r))
    }
    @Test fun timeoutCannotBecomeSuccessfulSnapshot() {
        val client = FixedCoreClient(4700, { "native-only-secret" }, CoreHttpTransport { _, _, _ -> throw SocketTimeoutException("fixture timeout") })
        assertThrows(java.io.IOException::class.java) { client.execute(client.beginPage(true), CoreUiRequest("POST", "/api/collaboration/result-files/native/snapshot", body = "{}".toByteArray())) }
    }
}
