package dev.litert.litertlm

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.util.Log

class LiteRTLMInitProvider : ContentProvider() {
    companion object {
        private const val TAG = "LiteRTLMInitProvider"
        var applicationContext: Context? = null
            private set
    }

    override fun onCreate(): Boolean {
        applicationContext = context?.applicationContext
        Log.i(TAG, "LiteRTLMInitProvider initialized with context: $applicationContext")
        
        applicationContext?.registerComponentCallbacks(object : android.content.ComponentCallbacks2 {
            // Only release the LLM engine when the OS is about to kill the
            // app outright (TRIM_MEMORY_COMPLETE = 80). The upstream lib
            // released at TRIM_MEMORY_RUNNING_LOW (10), which fires on
            // ordinary backgrounding and any moderate memory event — that
            // killed the loaded Gemma 4 engine while the user was just
            // navigating between screens, breaking on-device chat.
            // Reloading a 2.58 GB model takes ~30 s, so we bias toward
            // keeping it in memory until the OS forces eviction.
            override fun onTrimMemory(level: Int) {
                if (level >= android.content.ComponentCallbacks2.TRIM_MEMORY_COMPLETE) {
                    com.margelo.nitro.dev.litert.litertlm.LiteRTLMRegistry.onTrimMemory(level)
                }
            }

            override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {}
            override fun onLowMemory() {
                com.margelo.nitro.dev.litert.litertlm.LiteRTLMRegistry.onTrimMemory(android.content.ComponentCallbacks2.TRIM_MEMORY_COMPLETE)
            }
        })
        
        return true
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?
    ): Cursor? = null

    override fun getType(uri: Uri): String? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?
    ): Int = 0
}
