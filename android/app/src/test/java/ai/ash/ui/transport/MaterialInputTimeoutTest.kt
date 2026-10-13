package ai.ash.ui.transport
import org.junit.Test
import org.junit.Assert.assertEquals
import java.net.URL
class MaterialInputTimeoutTest {
 private fun request(method:String,path:String)=CoreHttpRequest(URL("http://127.0.0.1:14763$path"),method,emptyMap(),null,false)
 @Test fun onlyExactMaterialOperationPostsWaitForTheFixedCoreDeadline(){
  for(path in listOf("submit","send","retry")){
   val fixed="/api/collaboration/material/ui/input/$path"
   assertEquals(185000,fixedCoreReadTimeout(request("POST",fixed)))
   assertEquals(10000,fixedCoreReadTimeout(request("GET",fixed)))
   assertEquals(10000,fixedCoreReadTimeout(request("POST","$fixed?timeout=300000")))
   assertEquals(10000,fixedCoreReadTimeout(request("POST","$fixed/")))
  }
  for(path in listOf("/api/collaboration/material/ui/input/query","/api/collaboration/material/ui/draft/save","/api/send"))assertEquals(10000,fixedCoreReadTimeout(request("POST",path)))
 }
}
