package org.questix.webjoy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionUrlTest {
    @Test
    fun preservesPathAndEncodedToken() {
        val url = "http://192.168.10.1:8899/joy?token=a%2Bb%26c"
        assertEquals(url, ConnectionUrl.parse("  $url  ")?.toASCIIString())
        assertNotNull(ConnectionUrl.parse("https://robot.local/"))
        assertNotNull(ConnectionUrl.parse("http://[fd00::1]:8899/"))
    }

    @Test
    fun rejectsQrPayloadsThatAreNotRobotEndpoints() {
        for (url in listOf(
            "", "192.168.1.1:8899", "javascript:alert(1)", "file:///etc/passwd",
            "intent://robot", "http://user:password@robot/", "http://robot:0/",
            "http://robot:65536/", "http://robot:abc/", "http://robot/\npage",
            "http://robot\\@other/", "http://localhost:8899", "http://127.0.0.1/",
            "http://[::1]/", "http://0.0.0.0/", "http://localhost./",
        )) assertNull(url, ConnectionUrl.parse(url))
    }

    @Test
    fun navigationCannotChangeSchemeHostOrPort() {
        val original = ConnectionUrl.parse("http://robot.local/")!!
        assertTrue(ConnectionUrl.sameOrigin(original, ConnectionUrl.parse("http://ROBOT.local:80/page")!!))
        for (url in listOf("https://robot.local/", "http://other.local/", "http://robot.local:8899/")) {
            assertFalse(ConnectionUrl.sameOrigin(original, ConnectionUrl.parse(url)!!))
        }
    }
}
