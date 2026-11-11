package com.f2i.relay

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val a = intent.action ?: return
        if (a == Intent.ACTION_BOOT_COMPLETED ||
            a == "android.intent.action.QUICKBOOT_POWERON" ||
            a == Intent.ACTION_MY_PACKAGE_REPLACED) {
            try {
                val i = Intent(context, RelayService::class.java)
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i)
                else context.startService(i)
            } catch (_: Exception) {
                // Android 12+ 后台启动前台服务可能受系统限制，留待用户打开 App 启动
                RelayState.add("开机自启受系统后台限制，打开应用后会自动恢复")
            }
        }
    }
}
