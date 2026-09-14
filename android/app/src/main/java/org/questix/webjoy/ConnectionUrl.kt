package org.questix.webjoy

import java.net.URI
import java.util.Locale

/** Only explicit HTTP(S) endpoints; never execute a scheme from an arbitrary QR. */
internal object ConnectionUrl {
    fun parse(raw: String): URI? {
        val text = raw.trim()
        if (text.isEmpty() || text.length > 2048 || text.any { it <= ' ' || it == '\\' }) {
            return null
        }
        val uri = try {
            URI(text)
        } catch (_: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase(Locale.ROOT)
        val host = uri.host?.lowercase(Locale.ROOT)?.trimEnd('.') ?: return null
        if (scheme !in setOf("http", "https") || uri.rawUserInfo != null ||
            uri.port !in -1..65535 || uri.port == 0 ||
            host == "localhost" || host.endsWith(".localhost") || host.startsWith("127.") ||
            host in setOf("[::1]", "[::]", "0.0.0.0")
        ) {
            return null
        }
        return uri.takeIf { it.toASCIIString().length <= 2048 }
    }

    fun sameOrigin(first: URI, second: URI): Boolean {
        fun port(uri: URI) = if (uri.port != -1) uri.port
            else if (uri.scheme.equals("https", ignoreCase = true)) 443 else 80
        return first.scheme.equals(second.scheme, ignoreCase = true) &&
            first.host.equals(second.host, ignoreCase = true) && port(first) == port(second)
    }
}
