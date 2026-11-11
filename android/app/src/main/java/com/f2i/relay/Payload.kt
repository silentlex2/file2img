package com.f2i.relay

import java.io.ByteArrayOutputStream
import java.security.SecureRandom
import java.util.zip.CRC32
import java.util.zip.Deflater
import java.util.zip.Inflater
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * F2I1: [4B "F2I1"][4B dataLen][4B crc32][data]
 * F2I2: [4B "F2I2"][2B nameLen][4B dataLen][4B crc32][name][data]
 * F2I3: [4B "F2I3"][1B flags][2B nameLen][4B bodyLen][4B bodyCrc32]
 *       ([8B transferId][2B partIndex][2B partTotal])? [name][body]
 */
object Payload {

    const val MAGIC1 = "F2I1"
    const val MAGIC2 = "F2I2"
    const val MAGIC3 = "F2I3"
    private const val HEAD1 = 12
    private const val HEAD2 = 14
    private const val HEAD3 = 15
    private const val CHUNK_HEAD = 12

    const val F3_COMPRESSED = 0x01
    const val F3_ENCRYPTED = 0x02
    const val F3_CHUNKED = 0x04

    const val DEFAULT_PART_BYTES = 4_700_000
    private const val PBKDF2_ITERS = 100_000
    private val rng = SecureRandom()

    class Result(
        val name: String,
        val data: ByteArray,
        val version: Int = 2,
        val flags: Int = 0
    )

    class HeaderInfo(
        val version: Int,
        val flags: Int,
        val name: String,
        val bodyOffset: Int,
        val bodyLen: Int,
        val bodyCrc: Int,
        val transferIdHex: String,
        val partIndex: Int,
        val partTotal: Int
    ) {
        val compressed: Boolean get() = (flags and F3_COMPRESSED) != 0
        val encrypted: Boolean get() = (flags and F3_ENCRYPTED) != 0
        val chunked: Boolean get() = (flags and F3_CHUNKED) != 0
    }

    class RawBody(val header: HeaderInfo, val body: ByteArray)

    class PackResult(val parts: List<ByteArray>, val flags: Int, val transferIdHex: String)

    fun sanitizeFilename(raw: String?): String {
        val tail = (raw ?: "").replace('\\', '/').substringAfterLast('/')
        val clean = buildString {
            for (ch in tail) {
                val code = ch.code
                if (code < 0x20 || code == 0x7f) continue
                append(if (ch in "\\/:*?\"<>|") '_' else ch)
            }
        }.trim()
        return if (clean.isEmpty() || clean == "." || clean == "..") {
            "decoded_${System.currentTimeMillis()}.bin"
        } else {
            clean
        }
    }

    fun pack(data: ByteArray, name: String): ByteArray {
        val nb = name.toByteArray(Charsets.UTF_8)
        require(nb.size <= 65535) { "name too long" }
        val out = ByteArrayOutputStream(HEAD2 + nb.size + data.size)
        out.write(MAGIC2.toByteArray(Charsets.US_ASCII))
        out.write((nb.size ushr 8) and 0xFF)
        out.write(nb.size and 0xFF)
        writeInt(out, data.size)
        writeInt(out, crc32(data).toInt())
        out.write(nb)
        out.write(data)
        return out.toByteArray()
    }

    fun packParts(
        data: ByteArray,
        name: String,
        password: String? = null,
        compress: Boolean = true,
        maxPartBytes: Int = DEFAULT_PART_BYTES
    ): PackResult {
        val nb = name.toByteArray(Charsets.UTF_8)
        require(nb.size <= 65535) { "name too long" }
        require(maxPartBytes > 0) { "bad part size" }

        var stream = data
        var flags = 0
        if (compress) {
            val deflated = deflate(stream)
            if (deflated.size < stream.size) {
                stream = deflated
                flags = flags or F3_COMPRESSED
            }
        }
        if (!password.isNullOrEmpty()) {
            stream = encryptAesGcm(stream, password)
            flags = flags or F3_ENCRYPTED
        }

        if (stream.size <= maxPartBytes) {
            val single = if (flags == 0) {
                pack(stream, name)
            } else {
                packF2I3Part(flags, nb, stream, null, 0, 1)
            }
            return PackResult(listOf(single), flags, "")
        }

        flags = flags or F3_CHUNKED
        val partTotal = (stream.size + maxPartBytes - 1) / maxPartBytes
        require(partTotal <= 65535) { "too many parts" }
        val transferId = ByteArray(8)
        rng.nextBytes(transferId)
        val tidHex = toHex(transferId)
        val out = ArrayList<ByteArray>(partTotal)

        for (i in 0 until partTotal) {
            val start = i * maxPartBytes
            val end = minOf(stream.size, start + maxPartBytes)
            val body = stream.copyOfRange(start, end)
            out.add(packF2I3Part(flags, nb, body, transferId, i, partTotal))
        }
        return PackResult(out, flags, tidHex)
    }

    private fun packF2I3Part(
        flags: Int,
        nb: ByteArray,
        body: ByteArray,
        transferId: ByteArray?,
        partIndex: Int,
        partTotal: Int
    ): ByteArray {
        val chunked = (flags and F3_CHUNKED) != 0
        val headSize = HEAD3 + (if (chunked) CHUNK_HEAD else 0)
        val out = ByteArrayOutputStream(headSize + nb.size + body.size)
        out.write(MAGIC3.toByteArray(Charsets.US_ASCII))
        out.write(flags and 0xFF)
        out.write((nb.size ushr 8) and 0xFF)
        out.write(nb.size and 0xFF)
        writeInt(out, body.size)
        writeInt(out, crc32(body).toInt())
        if (chunked) {
            require(transferId != null && transferId.size == 8) { "bad transferId" }
            out.write(transferId)
            out.write((partIndex ushr 8) and 0xFF)
            out.write(partIndex and 0xFF)
            out.write((partTotal ushr 8) and 0xFF)
            out.write(partTotal and 0xFF)
        }
        out.write(nb)
        out.write(body)
        return out.toByteArray()
    }

    /** 只读头，判断是不是本工具的载荷 */
    fun looksLikePayload(bytes: ByteArray): Boolean {
        if (bytes.size < HEAD1) return false
        val m = String(bytes, 0, 4, Charsets.US_ASCII)
        return m == MAGIC3 || m == MAGIC2 || m == MAGIC1
    }

    fun inspectHeader(bytes: ByteArray): HeaderInfo {
        require(bytes.size >= HEAD1) { "too short" }
        val m = String(bytes, 0, 4, Charsets.US_ASCII)

        if (m == MAGIC3) {
            require(bytes.size >= HEAD3) { "too short for F2I3" }
            val flags = bytes[4].toInt() and 0xFF
            val nameLen = readUShort(bytes, 5)
            val bodyLen = readInt(bytes, 7)
            val bodyCrc = readInt(bytes, 11)
            val chunked = (flags and F3_CHUNKED) != 0
            val fixedHead = HEAD3 + (if (chunked) CHUNK_HEAD else 0)
            require(bytes.size >= fixedHead) { "too short for F2I3 chunk head" }

            var tidHex = ""
            var partIndex = 0
            var partTotal = 1
            if (chunked) {
                tidHex = toHex(bytes.copyOfRange(HEAD3, HEAD3 + 8))
                partIndex = readUShort(bytes, HEAD3 + 8)
                partTotal = readUShort(bytes, HEAD3 + 10)
                require(partTotal >= 2 && partIndex < partTotal) { "bad chunk index" }
            }
            val bodyOffset = fixedHead + nameLen
            require(bodyOffset <= bytes.size && bodyLen >= 0 && bodyLen <= bytes.size - bodyOffset) {
                "length out of range"
            }
            val name = String(bytes, fixedHead, nameLen, Charsets.UTF_8)
            return HeaderInfo(3, flags, name, bodyOffset, bodyLen, bodyCrc, tidHex, partIndex, partTotal)
        }

        if (m == MAGIC2) {
            require(bytes.size >= HEAD2) { "too short for F2I2" }
            val nameLen = readUShort(bytes, 4)
            val len = readInt(bytes, 6)
            val crc = readInt(bytes, 10)
            val bodyOffset = HEAD2 + nameLen
            require(bodyOffset <= bytes.size && len >= 0 && len <= bytes.size - bodyOffset) {
                "length out of range"
            }
            val name = String(bytes, HEAD2, nameLen, Charsets.UTF_8)
            return HeaderInfo(2, 0, name, bodyOffset, len, crc, "", 0, 1)
        }

        if (m == MAGIC1) {
            val len = readInt(bytes, 4)
            val crc = readInt(bytes, 8)
            require(len >= 0 && len <= bytes.size - HEAD1) { "length out of range" }
            return HeaderInfo(1, 0, "", HEAD1, len, crc, "", 0, 1)
        }

        throw IllegalArgumentException("not a payload image")
    }

    fun unpackRawBody(bytes: ByteArray): RawBody {
        val h = inspectHeader(bytes)
        val body = bytes.copyOfRange(h.bodyOffset, h.bodyOffset + h.bodyLen)
        require(crc32(body).toInt() == h.bodyCrc) { "crc mismatch" }
        return RawBody(h, body)
    }

    fun reassemble(parts: List<ByteArray>, flags: Int, password: String? = null): ByteArray {
        val stream = if (parts.size == 1) {
            parts[0]
        } else {
            val total = parts.sumOf { it.size }
            val out = ByteArray(total)
            var off = 0
            for (p in parts) {
                System.arraycopy(p, 0, out, off, p.size)
                off += p.size
            }
            out
        }
        val afterDecrypt = if ((flags and F3_ENCRYPTED) != 0) {
            decryptAesGcm(stream, password)
        } else {
            stream
        }
        return if ((flags and F3_COMPRESSED) != 0) {
            inflate(afterDecrypt)
        } else {
            afterDecrypt
        }
    }

    fun unpack(bytes: ByteArray, password: String? = null): Result {
        val raw = unpackRawBody(bytes)
        require(!raw.header.chunked) { "chunked payload requires reassembly" }
        val data = reassemble(listOf(raw.body), raw.header.flags, password)
        return Result(raw.header.name, data, raw.header.version, raw.header.flags)
    }

    private fun encryptAesGcm(plain: ByteArray, password: String): ByteArray {
        val salt = ByteArray(16)
        val iv = ByteArray(12)
        rng.nextBytes(salt)
        rng.nextBytes(iv)
        val key = deriveAesKey(password, salt)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
        val enc = cipher.doFinal(plain)
        val out = ByteArray(28 + enc.size)
        System.arraycopy(salt, 0, out, 0, 16)
        System.arraycopy(iv, 0, out, 16, 12)
        System.arraycopy(enc, 0, out, 28, enc.size)
        return out
    }

    private fun decryptAesGcm(data: ByteArray, password: String?): ByteArray {
        require(!password.isNullOrEmpty()) { "password required" }
        require(data.size >= 28 + 16) { "encrypted payload too short" }
        val salt = data.copyOfRange(0, 16)
        val iv = data.copyOfRange(16, 28)
        val key = deriveAesKey(password, salt)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
        return try {
            cipher.doFinal(data, 28, data.size - 28)
        } catch (e: Exception) {
            throw IllegalArgumentException("decrypt failed (wrong password or corrupted)", e)
        }
    }

    private fun deriveAesKey(password: String, salt: ByteArray): SecretKeySpec {
        val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        val spec = PBEKeySpec(password.toCharArray(), salt, PBKDF2_ITERS, 256)
        return SecretKeySpec(factory.generateSecret(spec).encoded, "AES")
    }

    private fun deflate(data: ByteArray): ByteArray {
        val d = Deflater(9)
        d.setInput(data)
        d.finish()
        val out = ByteArrayOutputStream(maxOf(64, data.size / 2))
        val buf = ByteArray(65536)
        try {
            while (!d.finished()) {
                val n = d.deflate(buf)
                if (n == 0) break
                out.write(buf, 0, n)
            }
        } finally {
            d.end()
        }
        return out.toByteArray()
    }

    private fun inflate(data: ByteArray): ByteArray {
        val inf = Inflater()
        inf.setInput(data)
        val out = ByteArrayOutputStream(maxOf(256, data.size * 2))
        val buf = ByteArray(65536)
        try {
            while (!inf.finished()) {
                val n = inf.inflate(buf)
                if (n == 0) {
                    if (inf.needsInput() || inf.needsDictionary()) {
                        throw IllegalStateException("truncated compressed stream")
                    }
                    continue
                }
                out.write(buf, 0, n)
            }
        } finally {
            inf.end()
        }
        return out.toByteArray()
    }

    private fun toHex(b: ByteArray): String =
        b.joinToString("") { "%02x".format(it.toInt() and 0xFF) }

    private fun readUShort(b: ByteArray, o: Int): Int =
        ((b[o].toInt() and 0xFF) shl 8) or (b[o + 1].toInt() and 0xFF)

    private fun writeInt(out: ByteArrayOutputStream, v: Int) {
        out.write((v ushr 24) and 0xFF)
        out.write((v ushr 16) and 0xFF)
        out.write((v ushr 8) and 0xFF)
        out.write(v and 0xFF)
    }

    private fun readInt(b: ByteArray, o: Int): Int =
        ((b[o].toInt() and 0xFF) shl 24) or
        ((b[o + 1].toInt() and 0xFF) shl 16) or
        ((b[o + 2].toInt() and 0xFF) shl 8) or
        (b[o + 3].toInt() and 0xFF)

    fun crc32(data: ByteArray): Long {
        val c = CRC32()
        c.update(data)
        return c.value
    }
}
