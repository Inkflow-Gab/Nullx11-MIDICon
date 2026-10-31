package com.nullx.midicon;

import java.util.Locale;

/** Keeps server-suggested download names inside the public Downloads/MIDICon folder. */
public final class DownloadSupport {
    private DownloadSupport() {}

    public static String safeFileName(String value) {
        String name = value == null ? "" : value;
        name = name.replaceAll("\\p{Cntrl}", "").replace('\\', '/');
        int slash = name.lastIndexOf('/');
        if (slash >= 0) {
            name = name.substring(slash + 1);
        }
        name = name.replaceAll("[*?\"<>|:]", "_").trim();
        while (name.startsWith(".")) {
            name = name.substring(1).trim();
        }
        if (name.isEmpty()) {
            name = "midicon-download";
        }
        if (name.length() > 120) {
            String lower = name.toLowerCase(Locale.ROOT);
            int dot = lower.lastIndexOf('.');
            String extension = dot > 0 && lower.length() - dot <= 10 ? name.substring(dot) : "";
            name = name.substring(0, 120 - extension.length()) + extension;
        }
        return name;
    }
}
