package com.nullx.midicon;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class ServerUrlTest {
    @Test
    public void normalizesHttpsOrigin() {
        assertEquals("https://midi.example.com", ServerUrl.normalize(" https://MIDI.Example.com/ "));
        assertEquals("https://midi.example.com:8443", ServerUrl.normalize("https://midi.example.com:8443"));
        assertEquals("https://midi.example.com", ServerUrl.normalize("https://midi.example.com:443/"));
    }

    @Test
    public void rejectsNonHttpsAndNonOriginInput() {
        String[] invalid = {
                "", "http://midi.example.com", "file:///etc/passwd", "javascript:alert(1)",
                "https://user:pass@midi.example.com", "https://midi.example.com/watch?v=1",
                "https://midi.example.com/#studio", "https://midi.example.com/app",
                "https://midi.example.com:99999", "https://"
        };
        for (String value : invalid) {
            try {
                ServerUrl.normalize(value);
                fail("Expected rejection for: " + value);
            } catch (IllegalArgumentException expected) {
                // expected
            }
        }
    }

    @Test
    public void comparesOriginsWithoutSendingCookiesCrossSite() {
        assertTrue(ServerUrl.sameOrigin("https://midi.example.com/api/jobs/1/download/midi", "https://midi.example.com"));
        assertTrue(ServerUrl.sameOrigin("https://midi.example.com:443/api/health", "https://midi.example.com"));
        assertFalse(ServerUrl.sameOrigin("https://evil.example.com/api", "https://midi.example.com"));
        assertFalse(ServerUrl.sameOrigin("http://midi.example.com/api", "https://midi.example.com"));
        assertFalse(ServerUrl.sameOrigin("https://midi.example.com:8443/api", "https://midi.example.com"));
    }
}
