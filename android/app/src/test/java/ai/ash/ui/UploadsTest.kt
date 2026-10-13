package ai.ash.ui

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class UploadsTest {
    private fun bytes(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }
    private val png = bytes(137, 80, 78, 71, 13, 10, 26, 10, 0, 0)

    @Test fun namesAreSafe() {
        assertEquals("a_b_c", Uploads.safeName("a/b\\c"))
        assertEquals("attachment", Uploads.safeName(""))
        assertEquals("attachment", Uploads.safeName(null))
        assertEquals("x_y", Uploads.safeName("x\u0001y"))
        assertEquals(180, Uploads.safeName("n".repeat(300)).length)
        assertEquals("图.png", Uploads.safeName("图.png"))
    }

    @Test fun magicBytes() {
        assertTrue(Uploads.rasterBytes("image/png", png))
        assertFalse(Uploads.rasterBytes("image/png", bytes(1, 2, 3)))
        assertTrue(Uploads.rasterBytes("image/jpeg", bytes(255, 216, 255, 0)))
        assertTrue(Uploads.rasterBytes("image/gif", "GIF89a....".toByteArray()))
        assertTrue(Uploads.rasterBytes("image/webp", "RIFF1234WEBP".toByteArray()))
        assertTrue(Uploads.rasterBytes("image/bmp", "BM..".toByteArray()))
        assertTrue(Uploads.rasterBytes("image/heic", "....ftypheic".toByteArray()))
        assertFalse(Uploads.rasterBytes("text/plain", png))
    }

    @Test fun aSayHasToFitOneFrame() {
        val small = JSONArray().put(JSONObject().put("name", "a.bin").put("mime_type", "application/octet-stream").put("data", "A".repeat(1000)))
        assertTrue(Uploads.fits("hi", small))
        val big = JSONArray().put(JSONObject().put("name", "a.bin").put("mime_type", "x/y").put("data", "A".repeat(Uploads.MAX_WIRE_BYTES)))
        assertFalse(Uploads.fits("hi", big))
    }

    @Test fun slashesCountOnce() {
        // JSON text for the wire does not escape "/", which base64 is full of.
        val a = JSONArray().put(JSONObject().put("name", "n").put("mime_type", "x/y").put("data", "/".repeat(1000)))
        val plain = JSONArray().put(JSONObject().put("name", "n").put("mime_type", "xxy").put("data", "A".repeat(1000)))
        assertEquals(Uploads.wireBytes("", plain) + 0, Uploads.wireBytes("", a))
    }

    @Test fun inlineDataIsChecked() {
        val enc = Base64.getEncoder().encodeToString(png)
        val ok = Uploads.decodeInline(enc, "image/png")
        assertNotNull(ok); assertTrue(ok!!.preview); assertEquals("image/png", ok.mime); assertArrayEquals(png, ok.bytes)
        // a picture type that is not a picture is just a file
        val lie = Uploads.decodeInline(Base64.getEncoder().encodeToString("hello".toByteArray()), "image/png")
        assertNotNull(lie); assertFalse(lie!!.preview); assertEquals("application/octet-stream", lie.mime)
        assertFalse(Uploads.decodeInline(Base64.getEncoder().encodeToString(png), "text/plain")!!.preview)
        assertNull(Uploads.decodeInline("", "image/png"))
        assertNull(Uploads.decodeInline("abc", "image/png"))
        assertNull(Uploads.decodeInline("ab\ncd", "image/png"))
        assertNull(Uploads.decodeInline("AAAA====", "image/png"))
        assertNull(Uploads.decodeInline("QUJD" + "A=\u0000=", "image/png"))
        // not canonical: padding bits set
        assertNull(Uploads.decodeInline("QUJ=", "x/y"))
    }
}

class AttachmentSizesTest {
    @Test fun base64Size() {
        assertEquals(0, Uploads.base64Size(""))
        assertEquals(3, Uploads.base64Size("QUJD"))
        assertEquals(2, Uploads.base64Size("QUI="))
        assertEquals(1, Uploads.base64Size("QQ=="))
    }
    @Test fun filePathsAreFileLinks() {
        assertTrue(Md.isFileLink("notes/a.md"))
        assertTrue(Md.isFileLink("/abs/a.md"))
        assertFalse(Md.isFileLink("https://x.y"))
        assertFalse(Md.isFileLink("javascript:alert(1)"))
        assertFalse(Md.isFileLink("//host/x"))
        assertFalse(Md.isFileLink("#top"))
        assertFalse(Md.isFileLink("a\\b"))
        assertFalse(Md.isFileLink(""))
    }
}
