package com.nullx.midicon;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** Validates the HTTPS origin of a MIDICon server before WebView or cookies touch it. */
public final class ServerUrl {
    private ServerUrl() {}

    public static String normalize(String value) {
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalArgumentException("Enter your MIDICon server URL.");
        }
        String trimmed = value.trim();
        if (trimmed.length() > 2048) {
            throw new IllegalArgumentException("That server URL is too long.");
        }
        URI uri;
        try {
            uri = new URI(trimmed);
        } catch (URISyntaxException exception) {
            throw new IllegalArgumentException("Enter a valid HTTPS URL, such as https://midi.example.com.");
        }
        if (!"https".equalsIgnoreCase(uri.getScheme())) {
            throw new IllegalArgumentException("Use an HTTPS server URL. HTTP is not enabled in this APK.");
        }
        if (uri.getRawUserInfo() != null) {
            throw new IllegalArgumentException("Do not include a username or password in the server URL.");
        }
        String host = uri.getHost();
        if (host == null || host.isEmpty()) {
            throw new IllegalArgumentException("Enter a server hostname, such as https://midi.example.com.");
        }
        if (uri.getQuery() != null || uri.getFragment() != null) {
            throw new IllegalArgumentException("Enter only the server origin, without a query or fragment.");
        }
        String path = uri.getPath();
        if (path != null && !path.isEmpty() && !"/".equals(path)) {
            throw new IllegalArgumentException("Enter the server root URL, not a page path.");
        }
        int port = uri.getPort();
        if (port != -1 && (port < 1 || port > 65535)) {
            throw new IllegalArgumentException("The server port must be between 1 and 65535.");
        }
        String authority = host.toLowerCase(Locale.ROOT);
        if (port != -1 && port != 443) {
            authority += ":" + port;
        }
        return "https://" + authority;
    }

    public static boolean sameOrigin(String first, String second) {
        try {
            URI a = new URI(first);
            URI b = new URI(second);
            if (!"https".equalsIgnoreCase(a.getScheme()) || !"https".equalsIgnoreCase(b.getScheme())) {
                return false;
            }
            if (a.getHost() == null || b.getHost() == null) {
                return false;
            }
            return a.getHost().equalsIgnoreCase(b.getHost()) && port(a) == port(b);
        } catch (URISyntaxException | NullPointerException exception) {
            return false;
        }
    }

    private static int port(URI uri) {
        int port = uri.getPort();
        return port == -1 ? 443 : port;
    }
}
