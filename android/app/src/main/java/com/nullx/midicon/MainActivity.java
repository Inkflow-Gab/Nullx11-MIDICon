package com.nullx.midicon;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.text.TextUtils;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native Android companion for a hosted MIDICon server. The WebView loads the server's own HTTPS
 * origin so the existing session cookie, CSRF checks, uploads, SSE progress, and downloads remain
 * same-origin. Neural transcription is deliberately not bundled into the APK.
 */
public final class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 1001;
    private static final int STORAGE_REQUEST = 1002;
    private static final int MENU_CHANGE_SERVER = 1;
    private static final int MENU_RELOAD = 2;
    private static final int MENU_OPEN_BROWSER = 3;
    private static final String PREFS = "midicon";
    private static final String KEY_SERVER = "server";

    private WebView webView;
    private View setupView;
    private View errorView;
    private EditText serverInput;
    private TextView setupError;
    private TextView errorText;
    private Button connectButton;
    private ProgressBar progressBar;
    private ValueCallback<Uri[]> filePathCallback;
    private Runnable pendingDownload;
    private String serverUrl = "";
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        webView = findViewById(R.id.web_view);
        setupView = findViewById(R.id.setup_view);
        errorView = findViewById(R.id.error_view);
        serverInput = findViewById(R.id.server_input);
        setupError = findViewById(R.id.setup_error);
        errorText = findViewById(R.id.error_text);
        connectButton = findViewById(R.id.connect_button);
        progressBar = findViewById(R.id.progress_bar);

        configureWebView();
        connectButton.setOnClickListener(view -> connect());
        serverInput.setOnEditorActionListener((view, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_GO) {
                connect();
                return true;
            }
            return false;
        });
        findViewById(R.id.retry_button).setOnClickListener(view -> reloadStudio());
        findViewById(R.id.change_server_button).setOnClickListener(view -> showSetup());

        String saved = preferences().getString(KEY_SERVER, "");
        if (saved != null && !saved.isEmpty()) {
            try {
                serverUrl = ServerUrl.normalize(saved);
                showWeb();
                webView.loadUrl(serverUrl);
            } catch (IllegalArgumentException exception) {
                showSetup();
            }
        } else {
            if (!BuildConfig.DEFAULT_SERVER.isEmpty()) {
                serverInput.setText(BuildConfig.DEFAULT_SERVER);
            }
            showSetup();
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        CookieManager.getInstance().setAcceptCookie(true);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSafeBrowsingEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString() + " MIDIConAndroid/" + BuildConfig.VERSION_NAME);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (ServerUrl.sameOrigin(url, serverUrl)) {
                    return false;
                }
                if (url.startsWith("https://") || url.startsWith("http://")) {
                    openExternal(url);
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                progressBar.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showError(getString(R.string.error_load));
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 400) {
                    showError(getString(R.string.error_http, response.getStatusCode()));
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) {
                handler.cancel();
                showError(getString(R.string.error_tls));
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(intent, getString(R.string.choose_file)), FILE_CHOOSER_REQUEST);
                } catch (ActivityNotFoundException exception) {
                    filePathCallback.onReceiveValue(null);
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, R.string.no_file_picker, Toast.LENGTH_LONG).show();
                    return false;
                }
                return true;
            }

            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }
        });

        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
                if (!ServerUrl.sameOrigin(url, serverUrl)) {
                    openExternal(url);
                    return;
                }
                String name = DownloadSupport.safeFileName(URLUtil.guessFileName(url, contentDisposition, mimetype));
                Runnable task = () -> enqueueDownload(url, name, mimetype);
                if (Build.VERSION.SDK_INT <= 28 && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                    pendingDownload = task;
                    requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, STORAGE_REQUEST);
                } else {
                    task.run();
                }
            }
        });
    }

    private void enqueueDownload(String url, String name, String mimetype) {
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            String cookie = CookieManager.getInstance().getCookie(url);
            if (!TextUtils.isEmpty(cookie)) {
                request.addRequestHeader("Cookie", cookie);
            }
            request.addRequestHeader("User-Agent", webView.getSettings().getUserAgentString());
            request.setTitle(name);
            request.setDescription(getString(R.string.download_description));
            request.setMimeType(mimetype);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "MIDICon/" + name);
            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            if (manager == null) {
                throw new IllegalStateException("DownloadManager unavailable");
            }
            manager.enqueue(request);
            Toast.makeText(this, getString(R.string.download_started, name), Toast.LENGTH_SHORT).show();
        } catch (RuntimeException exception) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show();
        }
    }

    private void connect() {
        String normalized;
        try {
            normalized = ServerUrl.normalize(serverInput.getText().toString());
        } catch (IllegalArgumentException exception) {
            setupError.setText(exception.getMessage());
            return;
        }
        connectButton.setEnabled(false);
        setupError.setText(R.string.checking_server);
        executor.execute(() -> {
            String error = checkHealth(normalized);
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) {
                    return;
                }
                connectButton.setEnabled(true);
                if (error != null) {
                    setupError.setText(error);
                    return;
                }
                serverUrl = normalized;
                preferences().edit().putString(KEY_SERVER, serverUrl).apply();
                setupError.setText("");
                showWeb();
                webView.loadUrl(serverUrl);
            });
        });
    }

    private String checkHealth(String base) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(base + "/api/health");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/json");
            int code = connection.getResponseCode();
            if (code == 503) {
                return getString(R.string.error_setup_required);
            }
            if (code != 200) {
                return getString(R.string.error_health_http, code);
            }
            String body = readLimited(connection.getInputStream());
            JSONObject json = new JSONObject(body);
            if (!"ready".equals(json.optString("status")) || json.optJSONArray("engines") == null || json.optJSONArray("engines").length() == 0) {
                return getString(R.string.error_not_ready);
            }
            return null;
        } catch (Exception exception) {
            return getString(R.string.error_unreachable);
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static String readLimited(InputStream input) throws Exception {
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int total = 0;
            int read;
            while ((read = stream.read(buffer)) != -1) {
                total += read;
                if (total > 65536) {
                    throw new IllegalStateException("Health response too large");
                }
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private void reloadStudio() {
        if (serverUrl.isEmpty()) {
            showSetup();
            return;
        }
        showWeb();
        webView.loadUrl(serverUrl);
    }

    private void showSetup() {
        setupView.setVisibility(View.VISIBLE);
        webView.setVisibility(View.GONE);
        errorView.setVisibility(View.GONE);
        progressBar.setVisibility(View.GONE);
        if (!serverUrl.isEmpty()) {
            serverInput.setText(serverUrl);
        }
        setTitle(R.string.app_name);
    }

    private void showWeb() {
        setupView.setVisibility(View.GONE);
        errorView.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        setTitle(R.string.app_name);
    }

    private void showError(String message) {
        progressBar.setVisibility(View.GONE);
        webView.setVisibility(View.GONE);
        setupView.setVisibility(View.GONE);
        errorView.setVisibility(View.VISIBLE);
        errorText.setText(message);
    }

    private void openExternal(String url) {
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme)) {
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException exception) {
            Toast.makeText(this, R.string.no_browser, Toast.LENGTH_SHORT).show();
        }
    }

    private SharedPreferences preferences() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, MENU_CHANGE_SERVER, 0, R.string.change_server).setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER);
        menu.add(0, MENU_RELOAD, 1, R.string.reload).setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM);
        menu.add(0, MENU_OPEN_BROWSER, 2, R.string.open_in_browser).setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        switch (item.getItemId()) {
            case MENU_CHANGE_SERVER:
                showSetup();
                return true;
            case MENU_RELOAD:
                if (webView.getVisibility() == View.VISIBLE) {
                    webView.reload();
                } else {
                    reloadStudio();
                }
                return true;
            case MENU_OPEN_BROWSER:
                if (!serverUrl.isEmpty()) {
                    openExternal(serverUrl);
                }
                return true;
            default:
                return super.onOptionsItemSelected(item);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || filePathCallback == null) {
            return;
        }
        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                results = new Uri[clip.getItemCount()];
                for (int i = 0; i < clip.getItemCount(); i++) {
                    results[i] = clip.getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
        }
        filePathCallback.onReceiveValue(results);
        filePathCallback = null;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != STORAGE_REQUEST) {
            return;
        }
        Runnable task = pendingDownload;
        pendingDownload = null;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED && task != null) {
            task.run();
        } else {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public void onBackPressed() {
        if (webView.getVisibility() == View.VISIBLE && webView.canGoBack()) {
            webView.goBack();
        } else if (webView.getVisibility() == View.VISIBLE || errorView.getVisibility() == View.VISIBLE) {
            showSetup();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        webView.onPause();
        webView.pauseTimers();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.resumeTimers();
        webView.onResume();
    }

    @Override
    protected void onDestroy() {
        executor.shutdownNow();
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
        ViewGroup parent = (ViewGroup) webView.getParent();
        if (parent != null) {
            parent.removeView(webView);
        }
        webView.destroy();
        super.onDestroy();
    }
}
