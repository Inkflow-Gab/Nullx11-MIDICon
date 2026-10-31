package com.nullx.midicon;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class DownloadSupportTest {
    @Test
    public void stripsPathTraversalAndControlCharacters() {
        assertEquals("song.mid", DownloadSupport.safeFileName("../../song.mid"));
        assertEquals("song.mid", DownloadSupport.safeFileName("song\u0000.mid"));
        assertEquals("c.mid", DownloadSupport.safeFileName("a/b\\c.mid"));
    }

    @Test
    public void providesFallbackAndPreservesShortExtensions() {
        assertEquals("midicon-download", DownloadSupport.safeFileName("..."));
        assertEquals("midicon-download", DownloadSupport.safeFileName(null));
        String longName = DownloadSupport.safeFileName(new String(new char[200]).replace('\0', 'a') + ".midi");
        assertEquals(120, longName.length());
        assertEquals(".midi", longName.substring(longName.length() - 5));
    }
}
