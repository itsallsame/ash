package ai.ash.kernel.host

import ai.ash.kernel.host.adb.AdbKey
import ai.ash.kernel.host.adb.AdbWire
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.DataInputStream
import java.math.BigInteger
import java.security.KeyFactory
import java.security.interfaces.RSAPublicKey
import java.security.spec.RSAPublicKeySpec

/** The adb formats Ash speaks to the phone's wireless debugging: what goes on the wire must be byte for byte what adbd expects. */
class AdbWireTest {
    private fun input(bytes: ByteArray) = DataInputStream(ByteArrayInputStream(bytes))

    @Test fun aMessageIsItsLittleEndianHeaderThenItsPayload() {
        val m = AdbWire.Message(AdbWire.A_CNXN, AdbWire.A_VERSION, AdbWire.A_MAXDATA, AdbWire.text("host::"))
        val bytes = AdbWire.encode(m)
        assertEquals(24 + 7, bytes.size)
        assertArrayEquals(byteArrayOf(0x43, 0x4e, 0x58, 0x4e), bytes.copyOfRange(0, 4)) // "CNXN"
        assertArrayEquals(byteArrayOf(7, 0, 0, 0), bytes.copyOfRange(12, 16))
        assertEquals("host::\u0000", String(bytes.copyOfRange(24, 31)))
        val back = AdbWire.read(input(bytes))
        assertEquals(AdbWire.A_CNXN, back.command); assertEquals(AdbWire.A_VERSION, back.arg0); assertArrayEquals(m.data, back.data)
    }

    @Test fun theChecksumIsTheSumOfTheUnsignedBytes() {
        assertEquals(0, AdbWire.checksum(ByteArray(0)))
        assertEquals(255 + 1 + 128, AdbWire.checksum(byteArrayOf(-1, 1, -128)))
    }

    @Test fun aMessageThatDoesNotHoldTogetherIsRefused() {
        val good = AdbWire.encode(AdbWire.Message(AdbWire.A_OKAY, 1, 2, byteArrayOf(1, 2, 3)))
        val badMagic = good.copyOf().also { it[20] = 0 }
        val badSum = good.copyOf().also { it[24] = 9 }
        for (bad in listOf(badMagic, badSum)) {
            try { AdbWire.read(input(bad)); fail("should refuse") } catch (_: IllegalStateException) {}
        }
    }

    @Test fun aPairingPacketIsVersionTypeAndABigEndianSize() {
        val p = AdbWire.packet(AdbWire.SPAKE2_MSG, byteArrayOf(9, 8, 7))
        assertArrayEquals(byteArrayOf(1, 0, 0, 0, 0, 3, 9, 8, 7), p)
        assertArrayEquals(byteArrayOf(9, 8, 7), AdbWire.readPacket(input(p), AdbWire.SPAKE2_MSG))
        try { AdbWire.readPacket(input(p), AdbWire.PEER_INFO); fail("wrong type") } catch (_: IllegalStateException) {}
    }

    @Test fun peerInfoCarriesTheKeyPaddedToItsSize() {
        val info = AdbWire.peerInfo("KEY name\u0000".toByteArray())
        assertEquals(AdbWire.PEER_INFO_SIZE, info.size)
        assertEquals(0, info[0].toInt())
        assertEquals("KEY name", String(info, 1, 8))
    }

    /** A key made by the adb tool (adb keygen): Ash writes its public key exactly as adbkey.pub has it. */
    @Test fun thePublicKeyIsEncodedAsAdbDoes() {
        val key = KeyFactory.getInstance("RSA").generatePublic(RSAPublicKeySpec(BigInteger(MODULUS, 16), BigInteger.valueOf(65537))) as RSAPublicKey
        val encoded = String(AdbKey.encodePublicKey(key, "ash@test"))
        assertTrue(encoded.endsWith(" ash@test\u0000"))
        assertEquals(ADB_PUB, encoded.substringBefore(' '))
    }

    private companion object {
        const val MODULUS = "D8ACC2F7229427E2315451270C3697BC13B1EA74CAC21F7C5CC0610902F492A12433776B822D9E8571CAD28938B1993D6506D2A679711E3E22E958A8E2B744A7749B846AD8DDD88CC0689C4A25DD4FD43AC83940D20AC3685DED8499B068AD897D037A1FE58C5A96627DC273C2506E9C888EDDCB4EC7558DC0AB3FF4091B42FB05155FBEF2294F9832908D53020CF6C45E244F480347F3FB17B8C2FB6491AD654B61D2F85D214C17CCB56CFEBC5FBF21579738538483351690847B5C97B725C676001EF935C828A8F68E8ADCA54FF87F7A0CB3F3B8BD798DB0E567EEB961A4D7443D3A5F732ED3B3B81C42CDC6CDC9AD1D830F4EDD3B720C3DD9C02259FA69AB"
        const val ADB_PUB = "QAAAAP22MjurafpZIsDZPQxyO91OD4MdrcnNxs1CHLiz0y5zXzo9RNekYbnuZ+WwjXm9uPOzDHp/+E+l3IqO9qgoyDX5HgB2xiW3l1x7hJAWNYOEUziXVyG/X7z+bLXMF0whXfjSYUtlrZFk+8K4F/vzRwNITyRexPYMAlONkDKYTynyvl8VBftCGwn0P6vAjVXHTsvdjoicblDCc8J9YpZajOUfegN9ia1osJmE7V1owwrSQDnIOtRP3SVKnGjAjNjd2GqEm3SnRLfiqFjpIj4ecXmm0gZlPZmxOInSynGFni2Ca3czJKGS9AIJYcBcfB/CynTqsRO8lzYMJ1FUMeInlCL3wqzYNtNn0Osu2BfDS5jnGhlxtLbgHi5+jDJgXaH75EUnsRv0Q5cS1/DliNC/ceHzTHGcUXOdkcJfxk51Z68QgxHYDv7JbSVERKaXCPpoxBsvbigr2URTr7Y6rkBSl4yZg91wHho0ftL1ksTfZHF1gJFycLJI2kwf7luvk6iIMxqYX+8ePe9F9lmdH91Arj/E3oLFkeFn0kLte5jdnSezHB6TMiDLM0/R77EMjr13/r2FE9GeXXk7mlc2HEehWYOyMbL7WGu4DaaCYkL2cOp/S3hnlu/CKjWic3pOamrqoNRxCd0B+S8nrpxct9bAHnzf/PXD1NTqG/34YI17YJu/B7EgCAEAAQA="
    }
}
