package com.f2i.relay

import android.content.Context
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object RelayState {
    private const val PREFS = "f2i_relay_prefs"
    private const val KEY_HANDLED = "handled_ids"
    private const val KEY_SELF = "self_ids"
    private const val MAX_PERSISTED_IDS = 500

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

    private val fmt = SimpleDateFormat("HH:mm:ss", Locale.US)

    @Synchronized
    fun init(context: Context) {
        if (initialized) return
        initialized = true
        val sp = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        loadIds(sp.getString(KEY_HANDLED, null), handledOrder, handledIds)
        loadIds(sp.getString(KEY_SELF, null), selfOrder, selfCreatedIds)
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
