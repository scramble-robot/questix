package org.questix.webjoy

import android.annotation.SuppressLint
import android.net.http.SslError
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.content.edit
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

class MainActivity : ComponentActivity() {
    private lateinit var root: FrameLayout
    private lateinit var form: View
    private lateinit var urlInput: EditText
    private lateinit var status: TextView
    private var controller: WebView? = null
    private val preferences by lazy { getSharedPreferences("connection", MODE_PRIVATE) }
    private val controllerBack = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() = disconnect(R.string.disconnected)
    }
    private val scanner = registerForActivityResult(ScanContract()) { result ->
        if (result.contents == null) {
            status.setText(R.string.scan_cancelled)
        } else {
            val endpoint = ConnectionUrl.parse(result.contents)
            if (endpoint == null) {
                status.setText(R.string.url_invalid)
            } else {
                urlInput.setText(endpoint.toASCIIString())
                urlInput.error = null
                status.setText(R.string.scan_ready)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_main)
        root = findViewById(R.id.root)
        form = findViewById(R.id.connection_form)
        urlInput = findViewById(R.id.connection_url)
        status = findViewById(R.id.connection_status)
        urlInput.setText(preferences.getString("url", ""))
        onBackPressedDispatcher.addCallback(this, controllerBack)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            // Keep touch controls out of camera cutouts and transient system bars.
            val safe = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
            )
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
            insets
        }
        findViewById<Button>(R.id.connect).setOnClickListener { connect() }
        urlInput.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_GO) {
                connect()
                true
            } else false
        }
        findViewById<Button>(R.id.scan).setOnClickListener {
            try {
                scanner.launch(
                    ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                        .setPrompt(getString(R.string.scan_prompt))
                        .setBeepEnabled(false).setOrientationLocked(false),
                )
            } catch (_: RuntimeException) {
                status.setText(R.string.scan_unavailable)
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled") // The controller page sends Joy via JavaScript/WebSocket.
    private fun connect() {
        if (controller != null) return
        val endpoint = ConnectionUrl.parse(urlInput.text.toString())
        if (endpoint == null) {
            urlInput.error = getString(R.string.url_invalid)
            return
        }
        val url = endpoint.toASCIIString()
        preferences.edit { putString("url", url) }
        urlInput.setText(url)
        urlInput.error = null
        status.text = ""
        WindowCompat.getInsetsController(window, root).hide(WindowInsetsCompat.Type.ime())
        form.visibility = View.GONE
        val web = WebView(this)
        controller = web
        controllerBack.isEnabled = true
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
        }
        web.webViewClient = object : WebViewClient() {
            private fun fail(message: Int) {
                // Defer destruction until after the WebView callback returns.
                root.post { if (controller === web) disconnect(message) }
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val target = ConnectionUrl.parse(request.url.toString())
                if (target != null && ConnectionUrl.sameOrigin(endpoint, target)) return false
                if (request.isForMainFrame) fail(R.string.navigation_blocked)
                return true
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) fail(R.string.connection_failed)
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame) fail(R.string.connection_failed)
            }

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                handler.cancel()
                fail(R.string.connection_failed)
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                fail(R.string.connection_failed)
                return true
            }
        }
        root.addView(web, FrameLayout.LayoutParams(-1, -1))
        web.requestFocus()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setControllerFullscreen(true)
        web.loadUrl(url)
    }

    private fun setControllerFullscreen(enabled: Boolean) {
        val insets = WindowCompat.getInsetsController(window, root)
        insets.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (enabled) insets.hide(WindowInsetsCompat.Type.systemBars())
        else insets.show(WindowInsetsCompat.Type.systemBars())
    }

    private fun disconnect(message: Int) {
        val web = controller
        controller = null
        if (web != null) {
            root.removeView(web)
            web.stopLoading()
            // onPause() alone leaves JavaScript timers running. Destroy the page so it
            // cannot keep sending held input or reclaim control while backgrounded.
            web.destroy()
        }
        controllerBack.isEnabled = false
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setControllerFullscreen(false)
        form.visibility = View.VISIBLE
        status.setText(message)
    }

    override fun onPause() {
        if (controller != null) disconnect(R.string.disconnected)
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && controller != null) setControllerFullscreen(true)
    }

    override fun onDestroy() {
        if (controller != null) disconnect(R.string.disconnected)
        super.onDestroy()
    }
}
