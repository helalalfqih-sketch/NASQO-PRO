package com.nasqo.proerp;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.OpenableColumns;
import android.util.AtomicFile;
import android.util.Base64;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;

@CapacitorPlugin(name = "NasqoStorage")
public class NasqoStoragePlugin extends Plugin {
    private static final Object DATABASE_LOCK = new Object();
    private static final int MAX_BYTES = 64 * 1024 * 1024;
    private static final byte[] SQLITE_HEADER = "SQLite format 3\u0000".getBytes(StandardCharsets.US_ASCII);

    private AtomicFile databaseFile() {
        return new AtomicFile(new File(getContext().getFilesDir(), "nasqo.sqlite"));
    }

    private byte[] readLimited(InputStream stream) throws Exception {
        if (stream == null) throw new FileNotFoundException("Cannot open selected file.");
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[32768];
            int length;
            while ((length = input.read(buffer)) != -1) {
                if (output.size() + length > MAX_BYTES) throw new IllegalArgumentException("File exceeds the 64 MB limit.");
                output.write(buffer, 0, length);
            }
            return output.toByteArray();
        }
    }

    private byte[] readDatabase() throws Exception {
        AtomicFile file = databaseFile();
        if (!file.getBaseFile().exists() && !new File(file.getBaseFile().getPath() + ".bak").exists()) return null;
        return readLimited(file.openRead());
    }

    private String revision(byte[] data) throws Exception {
        if (data == null) return "";
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(data);
        StringBuilder result = new StringBuilder();
        for (byte value : digest) result.append(String.format("%02x", value & 255));
        return result.toString();
    }

    private byte[] decode(String value) {
        if (value == null || value.length() > (MAX_BYTES * 4L / 3L) + 16) throw new IllegalArgumentException("Missing or oversized file.");
        byte[] bytes = Base64.decode(value, Base64.DEFAULT);
        if (bytes.length > MAX_BYTES) throw new IllegalArgumentException("File exceeds the 64 MB limit.");
        return bytes;
    }

    @PluginMethod
    public void load(PluginCall call) {
        try {
            synchronized (DATABASE_LOCK) {
                byte[] data = readDatabase();
                JSObject result = new JSObject();
                result.put("exists", data != null);
                result.put("revision", revision(data));
                if (data != null) result.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
                call.resolve(result);
            }
        } catch (Exception error) { call.reject("تعذر قراءة قاعدة البيانات المحلية.", error); }
    }

    @PluginMethod
    public void save(PluginCall call) {
        try {
            byte[] bytes = decode(call.getString("data"));
            if (bytes.length < SQLITE_HEADER.length || !Arrays.equals(Arrays.copyOf(bytes, SQLITE_HEADER.length), SQLITE_HEADER)) {
                throw new IllegalArgumentException("Invalid SQLite database header.");
            }
            synchronized (DATABASE_LOCK) {
                String expected = call.getString("expectedRevision", "");
                if (!revision(readDatabase()).equals(expected)) throw new IllegalStateException("Database changed in another session. Reopen the app.");
                AtomicFile file = databaseFile();
                FileOutputStream output = null;
                try {
                    output = file.startWrite();
                    output.write(bytes);
                    output.flush();
                    output.getFD().sync();
                    file.finishWrite(output);
                    output = null;
                } finally {
                    if (output != null) file.failWrite(output);
                }
                if (!revision(readDatabase()).equals(revision(bytes))) {
                    throw new IllegalStateException("Database save could not be verified.");
                }
                JSObject result = new JSObject();
                result.put("revision", revision(bytes));
                call.resolve(result);
            }
        } catch (Exception error) { call.reject("تعذر تأكيد حفظ قاعدة البيانات على الجهاز.", error); }
    }

    @PluginMethod
    public void pickFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        startActivityForResult(call, intent, "filePicked");
    }

    @ActivityCallback
    private void filePicked(PluginCall call, ActivityResult activityResult) {
        if (call == null) return;
        if (activityResult.getResultCode() != Activity.RESULT_OK || activityResult.getData() == null) {
            JSObject cancelled = new JSObject(); cancelled.put("cancelled", true); call.resolve(cancelled); return;
        }
        try {
            Uri uri = activityResult.getData().getData();
            if (uri == null) throw new FileNotFoundException();
            String name = "selected-file";
            try (Cursor cursor = getContext().getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
            }
            byte[] bytes = readLimited(getContext().getContentResolver().openInputStream(uri));
            JSObject result = new JSObject();
            result.put("fileName", name);
            result.put("mimeType", getContext().getContentResolver().getType(uri));
            result.put("sizeBytes", bytes.length);
            result.put("base64Content", Base64.encodeToString(bytes, Base64.NO_WRAP));
            call.resolve(result);
        } catch (Exception error) { call.reject("تعذر قراءة الملف المحدد.", error); }
    }

    @PluginMethod
    public void saveFile(PluginCall call) {
        try {
            decode(call.getString("base64Content"));
            String name = call.getString("filename", "nasqo-backup.json").replaceAll("[\\\\/\\r\\n]", "_");
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(call.getString("mimeType", "application/octet-stream"));
            intent.putExtra(Intent.EXTRA_TITLE, name);
            startActivityForResult(call, intent, "fileSaved");
        } catch (Exception error) { call.reject("بيانات الملف غير صالحة.", error); }
    }

    @ActivityCallback
    private void fileSaved(PluginCall call, ActivityResult activityResult) {
        if (call == null) return;
        if (activityResult.getResultCode() != Activity.RESULT_OK || activityResult.getData() == null) {
            call.reject("تم إلغاء حفظ الملف."); return;
        }
        try {
            Uri uri = activityResult.getData().getData();
            if (uri == null) throw new FileNotFoundException();
            try (OutputStream output = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                if (output == null) throw new FileNotFoundException();
                output.write(decode(call.getString("base64Content")));
                output.flush();
            }
            JSObject result = new JSObject(); result.put("saved", true); call.resolve(result);
        } catch (Exception error) { call.reject("تعذر حفظ الملف المحدد.", error); }
    }

    @PluginMethod
    public void showMessage(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Toast.makeText(getContext(), call.getString("message", ""), Toast.LENGTH_LONG).show();
            call.resolve();
        });
    }

    @PluginMethod
    public void print(PluginCall call) {
        String html = call.getString("html");
        if (html == null || html.length() > 8 * 1024 * 1024) { call.reject("المستند غير صالح للطباعة."); return; }
        getActivity().runOnUiThread(() -> {
            WebView printView = new WebView(getActivity());
            printView.getSettings().setJavaScriptEnabled(false);
            printView.getSettings().setBlockNetworkLoads(true);
            printView.setWebViewClient(new WebViewClient() {
                private boolean printed;
                @Override public void onPageFinished(WebView view, String url) {
                    if (printed) return;
                    printed = true;
                    try {
                        String title = call.getString("title", "NasqoProERP");
                        PrintDocumentAdapter delegate = view.createPrintDocumentAdapter(title);
                        PrintDocumentAdapter adapter = new PrintDocumentAdapter() {
                            @Override public void onStart() { delegate.onStart(); }
                            @Override public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes, CancellationSignal signal, LayoutResultCallback callback, Bundle extras) {
                                delegate.onLayout(oldAttributes, newAttributes, signal, callback, extras);
                            }
                            @Override public void onWrite(PageRange[] pages, ParcelFileDescriptor destination, CancellationSignal signal, WriteResultCallback callback) {
                                delegate.onWrite(pages, destination, signal, callback);
                            }
                            @Override public void onFinish() { delegate.onFinish(); view.destroy(); }
                        };
                        PrintManager manager = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                        manager.print(title, adapter, new PrintAttributes.Builder().build());
                        JSObject result = new JSObject(); result.put("dialogOpened", true); call.resolve(result);
                    } catch (Exception error) { printView.destroy(); call.reject("تعذر فتح الطباعة.", error); }
                }
            });
            printView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
        });
    }
}
