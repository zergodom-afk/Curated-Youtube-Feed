package app.mindfulfeed

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * A single WebView showing m.youtube.com, with the core JS bundle injected at document
 * start. All filtering happens in that script; this activity only provides:
 *  - injection + an origin-restricted message channel for the optional AI pass
 *  - Google sign-in compatible WebView settings
 *  - fullscreen video, back navigation, opening shared YouTube links
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var root: FrameLayout
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var curatorScript: String = ""
    private var documentStartSupported = false
    private val aiExecutor = Executors.newSingleThreadExecutor()

    private val prefs by lazy { getSharedPreferences("mindful", Context.MODE_PRIVATE) }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        curatorScript = assets.open("mindful-feed.js").bufferedReader().use { it.readText() }

        root = FrameLayout(this)
        webView = WebView(this)
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = true // no surprise autoplay
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportMultipleWindows(false)
            cacheMode = WebSettings.LOAD_DEFAULT
            // Google blocks sign-in from WebViews that announce themselves with "; wv".
            userAgentString = userAgentString.replace("; wv", "")
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        installScript()
        installMessageChannel()

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (isInternal(uri)) return false
                if (uri.scheme == "intent" || uri.scheme == "vnd.youtube") return true // never hand off to the YouTube app
                openExternal(uri)
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                // Fallback for old WebViews: inject as early as we can.
                if (!documentStartSupported && url != null && isYouTube(Uri.parse(url))) {
                    view.evaluateJavascript(curatorScript, null)
                }
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (customView != null) { callback.onCustomViewHidden(); return }
                customView = view
                customViewCallback = callback
                root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                webView.visibility = View.GONE
                WindowInsetsControllerCompat(window, root).apply {
                    hide(WindowInsetsCompat.Type.systemBars())
                    systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                }
            }

            override fun onHideCustomView() {
                customView?.let { root.removeView(it) }
                customView = null
                webView.visibility = View.VISIBLE
                customViewCallback?.onCustomViewHidden()
                customViewCallback = null
                WindowInsetsControllerCompat(window, root).show(WindowInsetsCompat.Type.systemBars())
            }
        }
        WindowCompat.setDecorFitsSystemWindows(window, true)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    customView != null -> webView.webChromeClient?.onHideCustomView()
                    webView.canGoBack() -> webView.goBack()
                    else -> moveTaskToBack(true) // keep the page (and your place) alive
                }
            }
        })

        if (savedInstanceState != null) webView.restoreState(savedInstanceState)
        else webView.loadUrl(urlFromIntent(intent) ?: HOME)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        urlFromIntent(intent)?.let { webView.loadUrl(it) }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        aiExecutor.shutdownNow()
        webView.destroy()
        super.onDestroy()
    }

    // ---------------------------------------------------------------------
    // Script injection & message channel
    // ---------------------------------------------------------------------

    private fun installScript() {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView, curatorScript, ALLOWED_ORIGINS)
            documentStartSupported = true
        }
    }

    private fun installMessageChannel() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        // Only pages served from YouTube's origins get the MindfulNative object.
        WebViewCompat.addWebMessageListener(webView, "MindfulNative", ALLOWED_ORIGINS) { _, message, _, isMainFrame, reply ->
            if (!isMainFrame) return@addWebMessageListener
            val msg = try { JSONObject(message.data ?: return@addWebMessageListener) } catch (e: Exception) { return@addWebMessageListener }
            when (msg.optString("type")) {
                "status" -> reply.postMessage(JSONObject().put("type", "status").put("hasKey", apiKey() != null).toString())
                "openSettings" -> showApiKeyDialog(reply)
                "classify" -> classify(msg, reply)
            }
        }
    }

    private fun classify(msg: JSONObject, reply: JavaScriptReplyProxy) {
        val requestId = msg.optString("requestId")
        val key = apiKey()
        if (key == null) {
            reply.postMessage(error(requestId, "No API key yet – tap “Set API key”."))
            return
        }
        val model = msg.optString("model").ifBlank { DEFAULT_MODEL }
        val items = msg.optJSONArray("items") ?: JSONArray()
        val needs = msg.optJSONArray("needs").toStringList().ifEmpty { DEFAULT_NEEDS }
        val topics = msg.optJSONArray("topics").toStringList()
        aiExecutor.execute {
            val response = try {
                val results = classifier(key).classify(model, items, needs, topics)
                JSONObject().put("type", "classifyResult").put("requestId", requestId).put("results", results).toString()
            } catch (e: AiClassifier.AiException) {
                error(requestId, e.message ?: "AI error")
            } catch (e: Exception) {
                error(requestId, "Unexpected error: ${e.javaClass.simpleName}")
            }
            runOnUiThread { reply.postMessage(response) }
        }
    }

    private var cachedClassifier: Pair<String, AiClassifier>? = null
    private fun classifier(key: String): AiClassifier {
        cachedClassifier?.let { (k, c) -> if (k == key) return c }
        return AiClassifier(key).also { cachedClassifier = key to it }
    }

    private fun error(requestId: String, message: String) =
        JSONObject().put("type", "error").put("requestId", requestId).put("message", message).toString()

    private fun apiKey(): String? = prefs.getString(KEY_API, null)?.takeIf { it.isNotBlank() }

    private fun showApiKeyDialog(reply: JavaScriptReplyProxy) {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val input = EditText(this).apply {
            hint = "sk-ant-…"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setText(apiKey() ?: "")
        }
        val info = TextView(this).apply {
            text = "Optional. With your own Anthropic API key, Claude labels each video more accurately than the " +
                "built-in keyword rules. Only titles, channel names and durations are sent. The key is stored " +
                "only on this device."
        }
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(info)
            addView(input)
        }
        AlertDialog.Builder(this)
            .setTitle("Anthropic API key")
            .setView(layout)
            .setPositiveButton("Save") { _, _ ->
                prefs.edit().putString(KEY_API, input.text.toString().trim()).apply()
                cachedClassifier = null
                reply.postMessage(JSONObject().put("type", "status").put("hasKey", apiKey() != null).toString())
            }
            .setNeutralButton("Remove") { _, _ ->
                prefs.edit().remove(KEY_API).apply()
                cachedClassifier = null
                reply.postMessage(JSONObject().put("type", "status").put("hasKey", false).toString())
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // ---------------------------------------------------------------------
    // URLs
    // ---------------------------------------------------------------------

    private fun isYouTube(uri: Uri): Boolean {
        val host = uri.host ?: return false
        return host == "youtube.com" || host.endsWith(".youtube.com")
    }

    private fun isInternal(uri: Uri): Boolean {
        val host = uri.host ?: return false
        if (uri.scheme != "https" && uri.scheme != "http") return false
        return isYouTube(uri) || host == "accounts.google.com" || host.endsWith(".google.com") ||
            host == "youtu.be" || host.endsWith(".gstatic.com") || host.endsWith(".googleusercontent.com")
    }

    private fun openExternal(uri: Uri) {
        try { startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)) }
        catch (e: ActivityNotFoundException) { /* nothing can open it */ }
    }

    /** Accepts youtube.com / youtu.be links (VIEW) and shared text containing one (SEND). */
    private fun urlFromIntent(intent: Intent?): String? {
        intent ?: return null
        val raw = when (intent.action) {
            Intent.ACTION_VIEW -> intent.dataString
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)?.let { LINK.find(it)?.value }
            else -> null
        } ?: return null
        val uri = Uri.parse(raw)
        val host = uri.host ?: return null
        if (host == "youtu.be") {
            val id = uri.pathSegments.firstOrNull() ?: return null
            return "https://m.youtube.com/watch?v=$id"
        }
        if (!isYouTube(uri)) return null
        return uri.buildUpon().scheme("https").authority("m.youtube.com").build().toString()
    }

    private fun JSONArray?.toStringList(): List<String> =
        if (this == null) emptyList() else (0 until length()).map { optString(it) }.filter { it.isNotBlank() }

    companion object {
        const val HOME = "https://m.youtube.com/"
        const val KEY_API = "anthropic_api_key"
        const val DEFAULT_MODEL = "claude-opus-5-5"
        val DEFAULT_NEEDS = listOf("relax", "laugh", "curious", "learn", "create", "inspire", "comfort")
        val ALLOWED_ORIGINS = setOf("https://m.youtube.com", "https://www.youtube.com")
        private val LINK = Regex("""https?://(?:[\w-]+\.)?(?:youtube\.com|youtu\.be)/\S+""")
    }
}
