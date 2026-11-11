package com.f2i.relay

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.provider.Settings
import android.text.Editable
import android.text.TextWatcher
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton

class MainActivity : AppCompatActivity() {

    companion object {
        private const val MAX_SEND_BYTES = 25L * 1024L * 1024L
        private const val PART_CLIP_DELAY_MS = 2500L
    }

    private lateinit var dot: android.view.View
    private lateinit var statusText: TextView
    private lateinit var seenCount: TextView
    private lateinit var savedCount: TextView
    private lateinit var toggleBtn: TextView
    private lateinit var sendBtn: MaterialButton
    private lateinit var logText: TextView
    private lateinit var permBtn: TextView
    private lateinit var inputBox: EditText
    private lateinit var passwordBox: EditText

    private val ui = Handler(Looper.getMainLooper())
    private var lastRenderedVersion = -1L

    private val refresher = object : Runnable {
        override fun run() {
            renderIfChanged()
            ui.postDelayed(this, 400)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        RelayState.init(this)
        setContentView(R.layout.activity_main)

        dot = findViewById(R.id.dot)
        statusText = findViewById(R.id.statusText)
        seenCount = findViewById(R.id.seenCount)
        savedCount = findViewById(R.id.savedCount)
        toggleBtn = findViewById(R.id.toggleBtn)
        sendBtn = findViewById(R.id.sendBtn)
        logText = findViewById(R.id.logText)
        permBtn = findViewById(R.id.permBtn)
        inputBox = findViewById(R.id.inputBox)
        passwordBox = findViewById(R.id.passwordBox)

        toggleBtn.setOnClickListener { toggleService() }
        sendBtn.setOnClickListener { pickFile() }
        permBtn.setOnClickListener { requestAllPerms(openAllFilesSettings = true) }

        passwordBox.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                RelayState.password = s?.toString() ?: ""
            }
        })

        // 点输入框 → 弹出键盘（豆包的剪贴板就在键盘里）
        inputBox.setOnClickListener {
            inputBox.requestFocus()
            val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            imm.showSoftInput(inputBox, InputMethodManager.SHOW_IMPLICIT)
        }

        // 启动时仅申请标准运行时权限，不强行跳出到系统设置页
        requestAllPerms(openAllFilesSettings = false)

        if (!RelayState.running) {
            try { startForegroundService(Intent(this, RelayService::class.java)) } catch (_: Exception) {}
        }

        renderIfChanged()
        ui.post(refresher)
    }

    override fun onDestroy() {
        ui.removeCallbacks(refresher)
        super.onDestroy()
    }

    private fun renderIfChanged() {
        if (RelayState.currentVersion() == lastRenderedVersion) return
        val snap = RelayState.snapshot()
        lastRenderedVersion = snap.version
        statusText.text = if (snap.running) "服务运行中" else "服务未启动"
        dot.backgroundTintList = ColorStateList.valueOf(
            Color.parseColor(if (snap.running) "#2ECC71" else "#8A9AB5")
        )
        seenCount.text = snap.seen.toString()
        savedCount.text = snap.saved.toString()
        toggleBtn.text = if (snap.running) "停止" else "启动"
        logText.text = snap.logText
        permBtn.text = if (Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager()) {
            "权限正常"
        } else {
            "授予删图权限"
        }
    }

    private fun toggleService() {
        val i = Intent(this, RelayService::class.java)
        if (RelayState.running) {
            stopService(i)
        } else {
            startForegroundService(i)
        }
        ui.postDelayed({ renderIfChanged() }, 300)
    }

    private fun requestAllPerms(openAllFilesSettings: Boolean) {
        val need = ArrayList<String>()
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) != PackageManager.PERMISSION_GRANTED)
                need.add(Manifest.permission.READ_MEDIA_IMAGES)
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                need.add(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            if (checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED)
                need.add(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        if (need.isNotEmpty()) requestPermissions(need.toTypedArray(), 100)

        if (openAllFilesSettings && Build.VERSION.SDK_INT >= 30 && !Environment.isExternalStorageManager()) {
            try {
                startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                        Uri.parse("package:" + packageName)
                    )
                )
            } catch (_: Exception) {}
        }
    }

    private fun pickFile() {
        val i = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
        }
        @Suppress("DEPRECATION")
        startActivityForResult(i, 200)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 200 && resultCode == RESULT_OK) {
            val uri = data?.data ?: return
            RelayState.add("正在编码…")
            Thread { sendFile(uri) }.start()
        }
    }

    private fun queryMeta(uri: Uri): Pair<String, Long> {
        return try {
            contentResolver.query(
                uri,
                arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
                null, null, null
            )?.use { c ->
                if (c.moveToFirst()) {
                    val name = c.getString(0) ?: "file.bin"
                    val size = if (!c.isNull(1)) c.getLong(1) else -1L
                    Pair(name, size)
                } else Pair("file.bin", -1L)
            } ?: Pair("file.bin", -1L)
        } catch (_: Exception) { Pair("file.bin", -1L) }
    }

    private fun sendFile(uri: Uri) {
        try {
            val (name, reportedSize) = queryMeta(uri)
            if (reportedSize > MAX_SEND_BYTES) {
                RelayState.add("文件过大 (${reportedSize / 1048576} MB)，单次上限 25 MB")
                return
            }

            val data = contentResolver.openInputStream(uri)?.use { it.readBytes() }
            if (data == null) { RelayState.add("读取失败"); return }
            if (data.size.toLong() > MAX_SEND_BYTES) {
                RelayState.add("文件过大 (${data.size / 1048576} MB)，单次上限 25 MB")
                return
            }

            val pw = RelayState.password
            val packed = Payload.packParts(data, name, password = pw, compress = true)
            val total = packed.parts.size
            val outUris = ArrayList<Uri>(total)
            val dims = ArrayList<Pair<Int, Int>>(total)

            for ((idx, partBytes) in packed.parts.withIndex()) {
                val npix = (partBytes.size + 2) / 3
                var w = Math.ceil(Math.sqrt(npix.toDouble())).toInt()
                if (w < 1) w = 1
                val h = (npix + w - 1) / w
                val rgb = ByteArray(w * h * 3)
                System.arraycopy(partBytes, 0, rgb, 0, partBytes.size)
                val png = PngCodec.encode(rgb, w, h)

                val suffix = if (total > 1) "_p${idx + 1}of$total" else ""
                val values = ContentValues().apply {
                    put(MediaStore.Images.Media.DISPLAY_NAME, "f2i_${System.currentTimeMillis()}$suffix.png")
                    put(MediaStore.Images.Media.MIME_TYPE, "image/png")
                    put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/DoubaoIme")
                    put(MediaStore.Images.Media.IS_PENDING, 1)
                }
                val outUri = contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                if (outUri == null) {
                    RelayState.add("插入相册失败")
                    return
                }
                val os = contentResolver.openOutputStream(outUri)
                if (os == null) {
                    try { contentResolver.delete(outUri, null, null) } catch (_: Exception) {}
                    RelayState.add("写入相册失败")
                    return
                }
                os.use { it.write(png) }
                values.clear()
                values.put(MediaStore.Images.Media.IS_PENDING, 0)
                contentResolver.update(outUri, values, null, null)

                try {
                    RelayState.markSelfCreated(this, ContentUris.parseId(outUri))
                } catch (_: Exception) {}
                outUris.add(outUri)
                dims.add(Pair(w, h))
            }

            val cm = getSystemService(ClipboardManager::class.java)
            for (idx in outUris.indices) {
                val outUri = outUris[idx]
                val (w, h) = dims[idx]
                runOnUiThread {
                    try {
                        val clip = ClipData.newUri(contentResolver, "image", outUri)
                        cm.setPrimaryClip(clip)
                        val partHint = if (total > 1) " [${idx + 1}/$total]" else ""
                        val encHint = if (pw.isNotEmpty()) " [加密]" else ""
                        RelayState.add("已复制$partHint$encHint: $name (${data.size} B → ${w}x${h})")
                    } catch (e: Exception) {
                        RelayState.add("剪贴板写入失败: " + (e.message ?: "?"))
                    }
                }
                if (idx + 1 < outUris.size) {
                    Thread.sleep(PART_CLIP_DELAY_MS)
                }
            }
        } catch (e: Exception) {
            RelayState.add("编码失败: " + (e.message ?: e.javaClass.simpleName))
        }
    }
}
