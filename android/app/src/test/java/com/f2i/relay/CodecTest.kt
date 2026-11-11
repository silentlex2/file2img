package com.f2i.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.security.MessageDigest

class CodecTest {

    private fun res(name: String): ByteArray {
        val f = File("src/test/resources/" + name)
        assertTrue("missing resource " + name, f.exists())
        return f.readBytes()
    }

    private fun sha(b: ByteArray): String {
        val d = MessageDigest.getInstance("SHA-256").digest(b)
        return d.joinToString("") { String.format("%02x", it) }
    }

    private fun toPng(packed: ByteArray): ByteArray {
        val npix = (packed.size + 2) / 3
        val w = Math.ceil(Math.sqrt(npix.toDouble())).toInt().coerceAtLeast(1)
        val h = (npix + w - 1) / w
        val rgb = ByteArray(w * h * 3)
        System.arraycopy(packed, 0, rgb, 0, packed.size)
        return PngCodec.encode(rgb, w, h)
    }

    @Test
    fun decodeSmallProbe() {
        val img = PngCodec.decode(res("probe_small.png"))
        assertEquals(256, img.w)
        assertEquals(235, img.h)
        assertTrue(Payload.looksLikePayload(img.rgb))
        val r = Payload.unpack(img.rgb)
        assertEquals(180037, r.data.size)
        assertEquals(64, sha(r.data).length)
    }

    @Test
    fun rejectNonPayload() {
        val img = PngCodec.decode(res("carrier.png"))
        assertFalse(Payload.looksLikePayload(img.rgb))
    }

    @Test
    fun encodeRoundTrip() {
        val data = ByteArray(5000) { (it * 37 % 256).toByte() }
        val packed = Payload.pack(data, "测试.txt")
        val png = toPng(packed)
        File("build/roundtrip.kt.png").writeBytes(png)

        val back = PngCodec.decode(png)
        val r2 = Payload.unpack(back.rgb)
        assertEquals("测试.txt", r2.name)
        assertEquals(sha(data), sha(r2.data))
    }

    @Test
    fun decodePalettePng() {
        val img = PngCodec.decode(res("palette.png"))
        assertEquals(321, img.w)
        assertEquals(320, img.h)
        assertTrue(Payload.looksLikePayload(img.rgb))
        val r = Payload.unpack(img.rgb)
        assertEquals("测试文件.txt", r.name)
        assertEquals(307218, r.data.size)
        assertTrue(r.data.decodeToString().contains("F2I-ROUNDTRIP-OK-20261111"))
    }

    @Test
    fun f2i3CompressAndEncryptRoundTrip() {
        val text = "F2I3 跨端压缩加密验证内容！".repeat(300).toByteArray(Charsets.UTF_8)
        val packRes = Payload.packParts(text, "密文.txt", password = "pw-口令-2026", compress = true)
        assertEquals(1, packRes.parts.size)
        assertTrue((packRes.flags and Payload.F3_COMPRESSED) != 0)
        assertTrue((packRes.flags and Payload.F3_ENCRYPTED) != 0)

        val png = toPng(packRes.parts[0])
        File("build/roundtrip_f2i3.kt.png").writeBytes(png)

        val decodedImg = PngCodec.decode(png)
        try {
            Payload.unpack(decodedImg.rgb, password = "wrong")
            fail("expected decrypt failure")
        } catch (_: IllegalArgumentException) { }

        val res = Payload.unpack(decodedImg.rgb, password = "pw-口令-2026")
        assertEquals("密文.txt", res.name)
        assertEquals(sha(text), sha(res.data))
    }

    @Test
    fun f2i3ChunkedOutOfOrderRoundTrip() {
        // 不可压缩随机数据，强制拆分成 >= 4 个分片
        val data = ByteArray(7500)
        java.util.Random(42).nextBytes(data)
        val packRes = Payload.packParts(data, "big.bin", password = "chunk-pw", compress = true, maxPartBytes = 1500)
        assertTrue(packRes.parts.size >= 4)

        val partPngs = packRes.parts.map { toPng(it) }.reversed() // 倒序接收
        val collected = HashMap<Int, ByteArray>()
        var flags = 0
        var total = 0
        for (png in partPngs) {
            val img = PngCodec.decode(png)
            val raw = Payload.unpackRawBody(img.rgb)
            assertTrue(raw.header.chunked)
            assertEquals("big.bin", raw.header.name)
            flags = raw.header.flags
            total = raw.header.partTotal
            collected[raw.header.partIndex] = raw.body
        }
        assertEquals(total, collected.size)
        val ordered = (0 until total).map { collected[it]!! }
        val restored = Payload.reassemble(ordered, flags, "chunk-pw")
        assertEquals(sha(data), sha(restored))
    }

    @Test
    fun sanitizeFilenameAndBoundsGuards() {
        assertEquals("evil_test_.txt", Payload.sanitizeFilename("../../foo/bar\\evil:test?.txt"))
        assertTrue(Payload.sanitizeFilename("..").startsWith("decoded_"))

        // 构造 Int 溢出长度头，确认不触发整型溢出越界异常之外的异常
        val forged = ByteArray(32)
        "F2I2".toByteArray(Charsets.US_ASCII).copyInto(forged, 0)
        forged[4] = 0; forged[5] = 0 // nameLen = 0
        forged[6] = 0x7F; forged[7] = 0xFF.toByte(); forged[8] = 0xFF.toByte(); forged[9] = 0xFF.toByte() // Int.MAX_VALUE
        try {
            Payload.unpack(forged)
            fail("expected length out of range")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("range"))
        }

        // 截断 PNG 应明确抛错
        val validPng = toPng(Payload.pack("hello".toByteArray(), "a.txt"))
        val truncated = validPng.copyOf(validPng.size - 10)
        try {
            PngCodec.decode(truncated)
            fail("expected truncated png error")
        } catch (_: Exception) { }
    }
}
