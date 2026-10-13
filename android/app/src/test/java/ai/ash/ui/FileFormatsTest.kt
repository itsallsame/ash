package ai.ash.ui

import ai.ash.ui.FileFormats.Kind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FileFormatsTest {
    @Test fun theEndingOfAName() {
        assertEquals(Kind.IMAGE, FileFormats.kindOfName("JPG"))
        assertEquals(Kind.PDF, FileFormats.kindOfName("pdf"))
        assertEquals(Kind.AUDIO, FileFormats.kindOfName("mp3"))
        assertEquals(Kind.VIDEO, FileFormats.kindOfName("mp4"))
        assertEquals(Kind.TABLE, FileFormats.kindOfName("tsv"))
        assertEquals(Kind.JSON, FileFormats.kindOfName("json"))
        assertEquals(Kind.MARKDOWN, FileFormats.kindOfName("md"))
        assertEquals(Kind.HTML, FileFormats.kindOfName("htm"))
        for (e in listOf("py", "js", "ts", "kt", "java", "sh", "yaml", "toml", "xml", "log", "svg", "gradle", "conf")) assertEquals(e, Kind.TEXT, FileFormats.kindOfName(e))
        assertEquals(Kind.OTHER, FileFormats.kindOfName("docx"))
        assertEquals(Kind.OTHER, FileFormats.kindOfName("zip"))
        assertNull(FileFormats.kindOfName("weird"))
        assertNull(FileFormats.kindOfName(""))
    }

    @Test fun anEndingTheViewerDoesNotKnowIsDecidedByTheTypeThenTheBytes() {
        assertEquals(Kind.IMAGE, FileFormats.kind("weird", "image/png", byteArrayOf(1)))
        assertEquals(Kind.PDF, FileFormats.kind("", "application/pdf", byteArrayOf(1)))
        assertEquals(Kind.AUDIO, FileFormats.kind("x", "audio/ogg", byteArrayOf(1)))
        assertEquals(Kind.TEXT, FileFormats.kind("weird", "application/octet-stream", "plain words, 中文 ok".toByteArray()))
        assertEquals(Kind.TEXT, FileFormats.kind("", null, ByteArray(0)))
        assertEquals(Kind.OTHER, FileFormats.kind("weird", "application/octet-stream", byteArrayOf(0x50, 0x4b, 3, 4, 0, 0)))
        // the ending wins over the type
        assertEquals(Kind.TEXT, FileFormats.kind("py", "application/octet-stream", byteArrayOf(0, 1)))
    }

    @Test fun textIsUtf8WithoutNul() {
        assertTrue(FileFormats.looksLikeText("héllo\n".toByteArray()))
        assertFalse(FileFormats.looksLikeText(byteArrayOf(0x68, 0x00, 0x69)))
        assertFalse(FileFormats.looksLikeText(byteArrayOf(0xff.toByte(), 0xfe.toByte(), 0x41)))
        // a character cut by the end of the 8 KiB sample is not a fault
        val long = ByteArray(8191) { 'a'.code.toByte() } + "中".toByteArray()
        assertTrue(FileFormats.looksLikeText(long))
    }

    @Test fun aLongTextIsCutAtTheLimit() {
        val (whole, cut1) = FileFormats.preview("﻿abc".toByteArray())
        assertEquals("abc", whole); assertFalse(cut1)
        val (head, cut2) = FileFormats.preview("中文中文".toByteArray(), max = 7)
        assertTrue(cut2)
        assertEquals("中文", head)
    }

    @Test fun csvWithQuotes() {
        val t = FileFormats.parseDelimited("a,b,c\r\n1,\"x,y\",\"say \"\"hi\"\"\"\n\n2,\"two\nlines\",\n", ',', 100, 10)
        assertEquals(listOf(listOf("a", "b", "c"), listOf("1", "x,y", "say \"hi\""), listOf("2", "two\nlines", "")), t.rows)
        assertFalse(t.moreRows); assertFalse(t.moreColumns)
    }

    @Test fun tsvAndTheLimits() {
        val t = FileFormats.parseDelimited("a\tb\tc\n1\t2\t3\n4\t5\t6\n7\t8\t9\n", '\t', 2, 2)
        assertEquals(listOf(listOf("a", "b"), listOf("1", "2")), t.rows)
        assertTrue(t.moreRows); assertTrue(t.moreColumns)
        assertFalse(FileFormats.parseDelimited("a,b\n1,2\n", ',', 2, 5).moreRows)
    }

    @Test fun jsonIsLaidOutAndNotRewritten() {
        assertEquals("{\n  \"a\": [\n    1,\n    2.50\n  ],\n  \"b\": {},\n  \"c\": \"x, {y}: \\\"z\\\"\"\n}", FileFormats.prettyJson("{\"a\":[1,2.50],\"b\":{ },\"c\":\"x, {y}: \\\"z\\\"\"}"))
        assertEquals("[]", FileFormats.prettyJson(" [ ] "))
        assertEquals("1", FileFormats.prettyJson("1"))
        assertNull(FileFormats.prettyJson("{\"a\":"))
        assertNull(FileFormats.prettyJson("{} extra"))
        assertNull(FileFormats.prettyJson(""))
    }

    @Test fun theEndingIsOfTheLastPartOfThePath() {
        assertEquals("pdf", FileLinks.extension("/root/work.d/a.PDF"))
        assertEquals("", FileLinks.extension("/root/a.b/Makefile"))
    }
}
