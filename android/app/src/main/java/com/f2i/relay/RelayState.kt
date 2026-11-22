package com.f2i.relay

import android.content.Context
import android.net.Uri
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object RelayState {
    private const val PREFS = "f2i_relay_prefs"
    private const val KEY_HANDLED = "handled_ids"
    private const val KEY_SELF = "self_ids"
    private const val KEY_PENDING_SEND = "pending_send_uris"
    private const val KEY_SELF_HASHES = "self_hashes"
    private const val MAX_PERSISTED_IDS = 500
    private const val MAX_SELF_HASHES = 100
    private const val SELF_HASH_TTL_MS = 10L * 60L * 1000L

    class Snapshot(
        val running: Boolean,
        val seen: Int,
        val saved: Int,
        val logText: String,
        val version: Long
    )

    @Volatile var running = false
        private set
    @Volatile var password = ""
    @Volatile var seen = 0
        private set
    @Volatile var saved = 0
        private set

    private var version = 1L
    private var initialized = false
    private val log = ArrayList<String>()
    private val handledOrder = ArrayDeque<Long>()
    private val handledIds = HashSet<Long>()
    private val selfOrder = ArrayDeque<Long>()
    private val selfCreatedIds = HashSet<Long>()
    private val pendingSendEntries = ArrayList<Pair<String, Long>>()
    private val selfHashEntries = ArrayList<Pair<String, Long>>()

    private val fmt = SimpleDateFormat("HH:mm:ss", Locale.US)

    @Synchronized
    fun init(context: Context) {
        if (initialized) return
        initialized = true
        val sp = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        loadIds(sp.getString(KEY_HANDLED, null), handledOrder, handledIds)
        loadIds(sp.getString(KEY_SELF, null), selfOrder, selfCreatedIds)
        loadTimestampedEntries(sp.getString(KEY_PENDING_SEND, null), pendingSendEntries)
        loadTimestampedEntries(sp.getString(KEY_SELF_HASHES, null), selfHashEntries)
    }

    private fun loadIds(raw: String?, order: ArrayDeque<Long>, set: HashSet<Long>) {
        if (raw.isNullOrBlank()) return
        for (part in raw.split(',')) {
            val id = part.trim().toLongOrNull() ?: continue
            if (set.add(id)) order.addLast(id)
        }
    }

    private fun saveIds(context: Context?, key: String, order: ArrayDeque<Long>) {
        if (context == null) return
        val sp = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        sp.edit().putString(key, order.joinToString(",")).apply()
    }

    private fun loadTimestampedEntries(raw: String?, target: MutableList<Pair<String, Long>>) {
        if (raw.isNullOrBlank()) return
        for (line in raw.split('\n')) {
            val idx = line.lastIndexOf('|')
            if (idx <= 0) continue
            val value = line.substring(0, idx).trim()
            val ts = line.substring(idx + 1).trim().toLongOrNull() ?: continue
            if (value.isNotEmpty()) target.add(Pair(value, ts))
        }
    }

    private fun saveTimestampedEntries(context: Context?, key: String, entries: List<Pair<String, Long>>) {
        if (context == null) return
        val sp = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val encoded = entries.joinToString("\n") { "${it.first}|${it.second}" }
        sp.edit().putString(key, encoded).apply()
    }

    fun sha256Hex(bytes: ByteArray, length: Int = bytes.size): String {
        val md = MessageDigest.getInstance("SHA-256")
        md.update(bytes, 0, length.coerceIn(0, bytes.size))
        return md.digest().joinToString("") { String.format(Locale.US, "%02x", it) }
    }

    @Synchronized
    fun addPendingSendUri(context: Context?, uriString: String, nowMs: Long = System.currentTimeMillis()) {
        if (uriString.isBlank()) return
        if (pendingSendEntries.none { it.first == uriString }) {
            pendingSendEntries.add(Pair(uriString, nowMs))
            saveTimestampedEntries(context, KEY_PENDING_SEND, pendingSendEntries)
        }
    }

    @Synchronized
    fun removePendingSendUri(context: Context?, uriString: String) {
        if (pendingSendEntries.removeAll { it.first == uriString }) {
            saveTimestampedEntries(context, KEY_PENDING_SEND, pendingSendEntries)
        }
    }

    @Synchronized
    fun claimPendingSendUris(context: Context?, minAgeMs: Long = 0L, nowMs: Long = System.currentTimeMillis()): List<String> {
        if (pendingSendEntries.isEmpty()) return emptyList()
        val claimed = ArrayList<String>()
        val remaining = ArrayList<Pair<String, Long>>()
        for (entry in pendingSendEntries) {
            if (nowMs - entry.second >= minAgeMs) {
                claimed.add(entry.first)
            } else {
                remaining.add(entry)
            }
        }
        if (claimed.isNotEmpty()) {
            pendingSendEntries.clear()
            pendingSendEntries.addAll(remaining)
            saveTimestampedEntries(context, KEY_PENDING_SEND, pendingSendEntries)
        }
        return claimed
    }

    fun cleanupPendingSendImages(context: Context, minAgeMs: Long = 0L): Int {
        init(context)
        val targets = claimPendingSendUris(context, minAgeMs)
        if (targets.isEmpty()) return 0
        var deleted = 0
        for (uriStr in targets) {
            try {
                if (context.contentResolver.delete(Uri.parse(uriStr), null, null) > 0) {
                    deleted++
                }
            } catch (_: Exception) { }
        }
        return deleted
    }

    private fun pruneSelfHashesLocked(nowMs: Long) {
        val cutoff = nowMs - SELF_HASH_TTL_MS
        selfHashEntries.removeAll { it.second < cutoff }
        while (selfHashEntries.size > MAX_SELF_HASHES) {
            selfHashEntries.removeAt(0)
        }
    }

    @Synchronized
    fun recordSelfHash(context: Context?, hashHex: String, nowMs: Long = System.currentTimeMillis()) {
        if (hashHex.isBlank()) return
        pruneSelfHashesLocked(nowMs)
        selfHashEntries.removeAll { it.first == hashHex }
        selfHashEntries.add(Pair(hashHex, nowMs))
        pruneSelfHashesLocked(nowMs)
        saveTimestampedEntries(context, KEY_SELF_HASHES, selfHashEntries)
    }

    @Synchronized
    fun isRecentSelfHash(hashHex: String, nowMs: Long = System.currentTimeMillis()): Boolean {
        if (hashHex.isBlank()) return false
        pruneSelfHashesLocked(nowMs)
        return selfHashEntries.any { it.first == hashHex }
    }

    private fun recordId(id: Long, order: ArrayDeque<Long>, set: HashSet<Long>) {
        if (!set.add(id)) return
        order.addLast(id)
        while (order.size > MAX_PERSISTED_IDS) {
            val old = order.removeFirst()
            set.remove(old)
        }
    }

    @Synchronized
    fun isKnownId(id: Long): Boolean = id in selfCreatedIds || id in handledIds

    @Synchronized
    fun markHandled(context: Context?, id: Long) {
        recordId(id, handledOrder, handledIds)
        saveIds(context, KEY_HANDLED, handledOrder)
    }

    @Synchronized
    fun markSelfCreated(context: Context?, id: Long) {
        recordId(id, selfOrder, selfCreatedIds)
        saveIds(context, KEY_SELF, selfOrder)
    }

    @Synchronized
    fun setRunning(value: Boolean) {
        if (running != value) {
            running = value
            version++
        }
    }

    @Synchronized
    fun incSeen() {
        seen++
        version++
    }

    @Synchronized
    fun incSaved() {
        saved++
        version++
    }

    @Synchronized
    fun add(msg: String) {
        log.add(0, "[" + fmt.format(Date()) + "] " + msg)
        while (log.size > 60) log.removeAt(log.size - 1)
        version++
    }

    @Synchronized
    fun currentVersion(): Long = version

    @Synchronized
    fun snapshot(): Snapshot {
        val text = if (log.isEmpty()) "（暂无记录）" else log.joinToString("\n")
        return Snapshot(running, seen, saved, text, version)
    }
}
