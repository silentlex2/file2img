package com.f2i.relay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.ContentUris
import android.content.ContentValues
import android.content.Intent
import android.database.ContentObserver
import android.net.Uri
import android.os.Environment
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.MediaStore
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class RelayService : Service() {

    companion object {
        private const val MAX_DECODE_PNG_BYTES = 32L * 1024L * 1024L
        private const val CHUNK_TTL_MS = 24L * 3600L * 1000L
    }

    private lateinit var handler: Handler
    private lateinit var worker: ExecutorService
    private var pending = false

    private val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean, uri: Uri?) {
            schedule()
        }
    }

    override fun onCreate() {
        super.onCreate()
        RelayState.init(this)
        handler = Handler(Looper.getMainLooper())
        worker = Executors.newSingleThreadExecutor()
        contentResolver.registerContentObserver(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true, observer
        )
        RelayState.setRunning(true)
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(1, buildNotification("监听 Pictures/DoubaoIme/ 中"))
        RelayState.setRunning(true)
        RelayState.add("服务已启动，监听 Pictures/DoubaoIme/")
        schedule()
        return START_STICKY
    }

    override fun onDestroy() {
        try { contentResolver.unregisterContentObserver(observer) } catch (_: Exception) {}
        handler.removeCallbacksAndMessages(null)
        worker.shutdownNow()
        RelayState.setRunning(false)
        RelayState.add("服务已停止")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun schedule() {
        if (pending) return
        pending = true
        handler.postDelayed({
            pending = false
            if (!worker.isShutdown) {
                worker.execute { scan() }
            }
        }, 900)
    }

    private fun scan() {
        try {
            val proj = arrayOf(
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.RELATIVE_PATH,
                MediaStore.Images.Media.SIZE,
                MediaStore.Images.Media.DATE_ADDED
            )
            val sel = MediaStore.Images.Media.RELATIVE_PATH + " LIKE ?"
            val cur = contentResolver.query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                proj, sel, arrayOf("%DoubaoIme%"),
                MediaStore.Images.Media.DATE_ADDED + " DESC"
            ) ?: return

            cur.use { c ->
                var n = 0
                while (c.moveToNext() && n < 30) {
                    n++
                    val id = c.getLong(0)
                    val size = c.getLong(3)
                    if (RelayState.isKnownId(id)) continue
                    RelayState.markHandled(this, id)
                    RelayState.incSeen()
                    process(id, size)
                }
            }
        } catch (e: Exception) {
            RelayState.add("扫描失败: " + (e.message ?: e.javaClass.simpleName))
        }
    }

    private fun process(id: Long, sizeHint: Long) {
        if (sizeHint > MAX_DECODE_PNG_BYTES) {
            RelayState.add("跳过过大图片 (${sizeHint / 1048576} MB)")
            return
        }
        val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
        try {
            val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return
            if (bytes.size.toLong() > MAX_DECODE_PNG_BYTES) {
                RelayState.add("跳过过大图片 (${bytes.size / 1048576} MB)")
                return
            }
            if (!PngCodec.isPng(bytes)) {
                RelayState.add("跳过非 PNG")
                return
            }
            val img = PngCodec.decode(bytes)
            if (!Payload.looksLikePayload(img.rgb)) {
                RelayState.add("跳过非载荷图 " + img.w + "x" + img.h)
                return
            }
            val raw = Payload.unpackRawBody(img.rgb)
            val h = raw.header
            val safeName = Payload.sanitizeFilename(h.name)

            if (!h.chunked) {
                val finalData = Payload.reassemble(listOf(raw.body), h.flags, RelayState.password)
                val saved = saveToDownloads(safeName, finalData)
                if (saved) {
                    RelayState.incSaved()
                    RelayState.add("已还原 $safeName (${finalData.size} B)")
                    updateNotification("最近还原: $safeName")
                    deleteImages(listOf(uri))
                }
                return
            }

            // 分片暂存与汇聚
            handleChunk(uri, h, raw.body, safeName)
        } catch (e: Exception) {
            val msg = e.message ?: e.javaClass.simpleName
            if (msg.contains("password") || msg.contains("decrypt")) {
                RelayState.add("解密失败（请先在页面填入正确解密口令）")
            } else {
                RelayState.add("处理失败: $msg")
            }
        }
    }

    private fun handleChunk(
        uri: Uri,
        h: Payload.HeaderInfo,
        body: ByteArray,
        safeName: String
    ) {
        val root = File(cacheDir, "f2i_chunks")
        cleanupStaleChunks(root)
        val batchDir = File(root, h.transferIdHex)
        batchDir.mkdirs()

        File(batchDir, "part_${h.partIndex}.bin").writeBytes(body)
        val urisFile = File(batchDir, "uris.txt")
        urisFile.appendText(uri.toString() + "\n")

        var count = 0
        for (i in 0 until h.partTotal) {
            if (File(batchDir, "part_$i.bin").exists()) count++
        }
        RelayState.add("收到分片 $count/${h.partTotal} · $safeName")

        if (count < h.partTotal) return

        val partBodies = ArrayList<ByteArray>(h.partTotal)
        for (i in 0 until h.partTotal) {
            partBodies.add(File(batchDir, "part_$i.bin").readBytes())
        }
        val finalData = Payload.reassemble(partBodies, h.flags, RelayState.password)
        val saved = saveToDownloads(safeName, finalData)
        if (saved) {
            RelayState.incSaved()
            RelayState.add("分片合并还原 $safeName (${finalData.size} B)")
            updateNotification("最近还原: $safeName")
            val sourceUris = if (urisFile.exists()) {
                urisFile.readLines().filter { it.isNotBlank() }.mapNotNull {
                    try { Uri.parse(it) } catch (_: Exception) { null }
                }
            } else emptyList()
            batchDir.deleteRecursively()
            deleteImages(sourceUris)
        }
    }

    private fun cleanupStaleChunks(root: File) {
        if (!root.exists()) return
        val cutoff = System.currentTimeMillis() - CHUNK_TTL_MS
        root.listFiles()?.forEach { dir ->
            if (dir.isDirectory && dir.lastModified() < cutoff) {
                dir.deleteRecursively()
            }
        }
    }

    private fun saveToDownloads(name: String, data: ByteArray): Boolean {
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream")
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/互传")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = try {
            contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        } catch (e: Exception) {
            RelayState.add("创建下载文件失败: " + (e.message ?: "?"))
            null
        } ?: return false

        return try {
            val os = contentResolver.openOutputStream(uri)
            if (os == null) {
                try { contentResolver.delete(uri, null, null) } catch (_: Exception) {}
                return false
            }
            os.use { it.write(data) }
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            contentResolver.update(uri, values, null, null)
            true
        } catch (e: Exception) {
            try { contentResolver.delete(uri, null, null) } catch (_: Exception) {}
            RelayState.add("保存失败: " + (e.message ?: "?"))
            false
        }
    }

    private fun deleteImages(uris: List<Uri>) {
        var deleted = 0
        var denied = false
        for (u in uris) {
            try {
                if (contentResolver.delete(u, null, null) > 0) deleted++
            } catch (_: Exception) {
                denied = true
            }
        }
        if (deleted > 0) {
            RelayState.add("已清理 $deleted 张原图")
        } else if (denied) {
            RelayState.add("保留了原图（未授所有文件访问权限，已记录去重）")
        }
    }

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        val ch = NotificationChannel("relay", "互传助手", NotificationManager.IMPORTANCE_LOW)
        ch.setShowBadge(false)
        nm.createNotificationChannel(ch)
    }

    private fun updateNotification(text: String) {
        try {
            val nm = getSystemService(NotificationManager::class.java)
            nm.notify(1, buildNotification(text))
        } catch (_: Exception) {}
    }

    private fun buildNotification(text: String): Notification {
        return Notification.Builder(this, "relay")
            .setContentTitle("互传助手")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setOngoing(true)
            .build()
    }
}
