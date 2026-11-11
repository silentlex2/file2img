package com.f2i.relay

import java.io.ByteArrayOutputStream
import java.util.zip.CRC32
import java.util.zip.Deflater
import java.util.zip.Inflater

/**
 * 自写 PNG 编解码。不使用 BitmapFactory，避免色彩空间转换破坏像素数据。
 * 支持 color type: 0(灰度) 2(RGB) 3(调色板) 4(灰度+alpha) 6(RGBA)，位深 1/2/4/8/16。
 */
object PngCodec {

    class Image(val w: Int, val h: Int, val rgb: ByteArray)

    private val SIG = byteArrayOf(
        0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A
    )

    fun isPng(b: ByteArray): Boolean {
        if (b.size < 8) return false
        for (i in SIG.indices) if (b[i] != SIG[i]) return false
        return true
    }

    fun decode(src: ByteArray): Image {
        require(isPng(src)) { "not a png" }
        var off = 8
        var w = 0
        var h = 0
        var depth = 0
        var ctype = 0
        var interlace = 0
        var ihdrSeen = false
        var iendSeen = false
        var palette: ByteArray? = null
        val idat = ByteArrayOutputStream()

        while (off + 8 <= src.size) {
            val len = readInt(src, off)
            require(len >= 0 && off + 12 <= src.size && len <= src.size - (off + 12)) {
                "truncated png chunk"
            }
            val type = String(src, off + 4, 4, Charsets.US_ASCII)
            when (type) {
                "IHDR" -> {
                    require(len >= 13) { "bad IHDR" }
                    w = readInt(src, off + 8)
                    h = readInt(src, off + 12)
                    depth = src[off + 16].toInt() and 0xFF
                    ctype = src[off + 17].toInt() and 0xFF
                    interlace = src[off + 20].toInt() and 0xFF
                    ihdrSeen = true
                }
                "PLTE" -> palette = src.copyOfRange(off + 8, off + 8 + len)
                "IDAT" -> idat.write(src, off + 8, len)
                "IEND" -> { iendSeen = true; break }
            }
            off += 12 + len
        }

        require(ihdrSeen && w > 0 && h > 0) { "bad dimensions" }
        require(iendSeen) { "truncated png (missing IEND)" }
        require(interlace == 0) { "interlaced png unsupported" }
        val idatBytes = idat.toByteArray()
        require(idatBytes.isNotEmpty()) { "missing IDAT" }

        val raw = inflate(idatBytes)

        // ---- 调色板索引色 ----
        if (ctype == 3) {
            val pal = palette ?: throw IllegalArgumentException("palette png without PLTE")
            require(depth == 1 || depth == 2 || depth == 4 || depth == 8) { "bad palette depth $depth" }
            val rowBytes = (w * depth + 7) / 8
            val px = unfilter(raw, rowBytes, h, 1)
            val rgb = ByteArray(w * h * 3)
            var o = 0
            for (y in 0 until h) {
                val rowStart = y * rowBytes
                for (x in 0 until w) {
                    val idx = indexAt(px, rowStart, x, depth)
                    val p = idx * 3
                    if (p + 2 < pal.size) {
                        rgb[o] = pal[p]
                        rgb[o + 1] = pal[p + 1]
                        rgb[o + 2] = pal[p + 2]
                    }
                    o += 3
                }
            }
            return Image(w, h, rgb)
        }

        require(depth == 8 || depth == 16) { "unsupported bit depth $depth" }
        val ch = when (ctype) {
            0 -> 1
            2 -> 3
            4 -> 2
            6 -> 4
            else -> throw IllegalArgumentException("unsupported color type $ctype")
        }
        val bytesPerSample = if (depth == 16) 2 else 1
        val bpp = ch * bytesPerSample
        val stride = w * bpp
        val px = unfilter(raw, stride, h, bpp)

        if (depth == 8 && ch == 3) return Image(w, h, px)

        val rgb = ByteArray(w * h * 3)
        var o = 0
        if (depth == 8) {
            var i = 0
            while (i < w * h) {
                val s = i * ch
                if (ch >= 3) {
                    rgb[o] = px[s]
                    rgb[o + 1] = px[s + 1]
                    rgb[o + 2] = px[s + 2]
                } else {
                    rgb[o] = px[s]
                    rgb[o + 1] = px[s]
                    rgb[o + 2] = px[s]
                }
                i++
                o += 3
            }
        } else {
            var i = 0
            while (i < w * h) {
                val s = i * bpp
                if (ch >= 3) {
                    rgb[o] = px[s]
                    rgb[o + 1] = px[s + 2]
                    rgb[o + 2] = px[s + 4]
                } else {
                    rgb[o] = px[s]
                    rgb[o + 1] = px[s]
                    rgb[o + 2] = px[s]
                }
                i++
                o += 3
            }
        }
        return Image(w, h, rgb)
    }

    private fun indexAt(row: ByteArray, rowStart: Int, x: Int, depth: Int): Int {
        return when (depth) {
            8 -> row[rowStart + x].toInt() and 0xFF
            4 -> {
                val b = row[rowStart + x / 2].toInt() and 0xFF
                if (x % 2 == 0) (b ushr 4) and 0x0F else b and 0x0F
            }
            2 -> {
                val b = row[rowStart + x / 4].toInt() and 0xFF
                val sh = (3 - (x % 4)) * 2
                (b ushr sh) and 0x03
            }
            1 -> {
                val b = row[rowStart + x / 8].toInt() and 0xFF
                (b ushr (7 - (x % 8))) and 0x01
            }
            else -> throw IllegalArgumentException("bad palette depth")
        }
    }

    fun encode(rgb: ByteArray, w: Int, h: Int): ByteArray {
        val stride = w * 3
        val raw = ByteArray((stride + 1) * h)
        for (y in 0 until h) {
            raw[y * (stride + 1)] = 0
            System.arraycopy(rgb, y * stride, raw, y * (stride + 1) + 1, stride)
        }
        val comp = deflate(raw)
        val out = ByteArrayOutputStream(comp.size + 128)
        out.write(SIG)
        val ihdr = ByteArray(13)
        writeInt(ihdr, 0, w)
        writeInt(ihdr, 4, h)
        ihdr[8] = 8
        ihdr[9] = 2
        out.write(chunk("IHDR", ihdr))
        out.write(chunk("IDAT", comp))
        out.write(chunk("IEND", ByteArray(0)))
        return out.toByteArray()
    }

    private fun chunk(type: String, data: ByteArray): ByteArray {
        val tb = type.toByteArray(Charsets.US_ASCII)
        val out = ByteArray(12 + data.size)
        writeInt(out, 0, data.size)
        System.arraycopy(tb, 0, out, 4, 4)
        System.arraycopy(data, 0, out, 8, data.size)
        val crc = CRC32()
        crc.update(tb)
        crc.update(data)
        writeInt(out, 8 + data.size, crc.value.toInt())
        return out
    }

    /** stride 为每行字节数，bpp 为滤波单元（字节） */
    private fun unfilter(raw: ByteArray, stride: Int, h: Int, bpp: Int): ByteArray {
        val expected = (stride.toLong() + 1L) * h.toLong()
        require(raw.size.toLong() >= expected) { "truncated png pixel stream" }
        val out = ByteArray(stride * h)
        var pos = 0
        for (y in 0 until h) {
            val ft = raw[pos++].toInt() and 0xFF
            val rowStart = y * stride
            val prevStart = rowStart - stride
            for (x in 0 until stride) {
                val v = raw[pos++].toInt() and 0xFF
                val a = if (x >= bpp) out[rowStart + x - bpp].toInt() and 0xFF else 0
                val b = if (y > 0) out[prevStart + x].toInt() and 0xFF else 0
                val c = if (y > 0 && x >= bpp) out[prevStart + x - bpp].toInt() and 0xFF else 0
                val r = when (ft) {
                    0 -> v
                    1 -> (v + a) and 0xFF
                    2 -> (v + b) and 0xFF
                    3 -> (v + ((a + b) ushr 1)) and 0xFF
                    4 -> {
                        val p = a + b - c
                        val pa = Math.abs(p - a)
                        val pb = Math.abs(p - b)
                        val pc = Math.abs(p - c)
                        val pr = if (pa <= pb && pa <= pc) a else if (pb <= pc) b else c
                        (v + pr) and 0xFF
                    }
                    else -> throw IllegalArgumentException("bad filter $ft")
                }
                out[rowStart + x] = r.toByte()
            }
        }
        return out
    }

    private fun inflate(data: ByteArray): ByteArray {
        val inf = Inflater()
        inf.setInput(data)
        val out = ByteArrayOutputStream(data.size * 4 + 1024)
        val buf = ByteArray(65536)
        try {
            while (!inf.finished()) {
                val n = try { inf.inflate(buf) } catch (e: Exception) {
                    throw IllegalStateException("inflate failed: ${e.message}")
                }
                if (n == 0) {
                    if (inf.needsInput() || inf.needsDictionary()) {
                        throw IllegalStateException("truncated inflate stream")
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

    private fun deflate(data: ByteArray): ByteArray {
        val d = Deflater(9)
        d.setInput(data)
        d.finish()
        val out = ByteArrayOutputStream(data.size / 2 + 1024)
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

    private fun readInt(b: ByteArray, o: Int): Int =
        ((b[o].toInt() and 0xFF) shl 24) or
        ((b[o + 1].toInt() and 0xFF) shl 16) or
        ((b[o + 2].toInt() and 0xFF) shl 8) or
        (b[o + 3].toInt() and 0xFF)

    private fun writeInt(b: ByteArray, o: Int, v: Int) {
        b[o] = (v ushr 24).toByte()
        b[o + 1] = (v ushr 16).toByte()
        b[o + 2] = (v ushr 8).toByte()
        b[o + 3] = v.toByte()
    }
}
