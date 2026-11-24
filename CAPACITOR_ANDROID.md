# NASQO Pro — Capacitor Android

This target packages the existing offline React interface with Capacitor 8 and
implements the `NasqoHome` protocol without requiring a Flutter host. It uses
the same accounting functions and SQLite schema as `server/sqliteDb.ts`.

## Build

Use Node.js 24, JDK 21 and Android SDK platform/build-tools 36. The committed
Android project has package ID `com.nasqo.proerp`. Keep all three Capacitor
core/CLI/Android packages on the locked version.

```bash
npm ci
npm run android:debug
```

Set `JAVA_HOME` and `ANDROID_HOME` to the installed JDK and Android SDK if your
environment does not already provide them. The build writes `android/local.properties`
from `ANDROID_HOME` only if the file does not exist. This machine-specific file
must not be committed.

The APK is `android/app/build/outputs/apk/debug/app-debug.apk`. It is a debug
build for device testing, not a signed store release. The GitHub Actions workflow
`Build Capacitor Android APK` also attaches it as `NasqoProERP-debug` after a
successful pull-request build. Download and unzip that artifact.

The build commands have separate purposes:

| Command | Output |
| --- | --- |
| `npm run build` | Existing website in `dist/client` and Sites server output |
| `npm run build:hybrid` | Existing Flutter bundle in `dist/hybrid/index.html` |
| `npm run build:capacitor` | Android web bundle in `dist/capacitor/index.html` |
| `npm run android:sync` | Build the Android bundle and copy it into the native project |
| `npm run android:debug` | Build, sync and run Gradle `assembleDebug` |

Do not copy `dist/hybrid/hybrid.html`: the existing hybrid build renames that
file to `index.html`. Do not run `cap init` or `cap add android` again on this
branch; the configuration and Android sources are already present.

`android/app/build.gradle` uses the Kotlin 1.8.22 BOM to align old `jdk7`/`jdk8`
artifacts with the standard library and address the reported duplicate classes.
It does not change the Kotlin compiler globally or suppress duplicate checks.

## Local database behavior

- A new install starts with an empty workspace and schema. It does not seed
  customers, inventory, invoices or balances and never restores a backup automatically.
- SQLite runs in bundled WASM through `sql.js`. The operational database is
  stored as `files/nasqo.sqlite` in the Android application sandbox. It is not
  stored in IndexedDB, Firebase or a remote server.
- Commands are serialized. Accounting writes and idempotency receipts share
  one SQLite transaction. The response is successful only after the native
  plugin writes and verifies the SQLite file with `AtomicFile` and `fsync`.
- A failed save restores the last durable in-memory checkpoint. A revision
  check prevents another app session from silently overwriting a newer file.
- Each write exports the complete database. The current file limit is 64 MiB;
  large databases require measured device testing or a native SQLite execution
  backend before production use. The database is private app storage, not an
  encrypted SQLCipher database.
- Backup and restore are explicit user actions through Android's document picker.
  `.sqlite` export writes SQLite bytes; JSON export uses the unified backup schema.
  Restore validates a selected compatible SQLite/JSON file in isolation before
  changing the working database. Legacy SQL dumps must first be converted to
  the unified format. Android automatic cloud backup is disabled.

## Supported scope and pending device checks

The bridge supports accounts/groups, currencies, ledger entries and invoices,
warehouses, inventory, existing ERP data, settings/preferences and local backup/
restore. It bundles the SQLite WASM module and fonts for offline startup.

Invoice and account-statement print requests open the Android system print
dialog, where the user can choose Save as PDF. Other report print kinds return
an explicit unsupported error rather than printing unrelated financial data.
Google Drive, WhatsApp/SMS integrations and browser-only Excel download/share
flows have not been converted to native plugins. They are not claimed as working
native features. Camera scanning and native lifecycle/keyboard/print interactions
still need device validation.

Automated repository tests cover restart persistence, invoice/stock atomicity,
idempotency, concurrent commands, disk failure, protocol rejection, backup/restore,
and Arabic spreadsheet parsing. Existing accounting and hybrid contract tests also
remain applicable. A successful web build alone does not verify an APK or device
behavior. Before real financial use, test on Android: cold start without network,
create a test account and invoice, force-stop/reopen and verify balances/stock,
export/restore a test backup, hardware Back, keyboard and PDF printing.

## Dependency updates

The lockfile updates Vite to 8.3.8, consumes SheetJS 0.20.3 from its official
distribution, and applies narrow patched overrides for Firestore's gRPC dependency
and the legacy drizzle-kit esbuild loader. Do not run `npm audit fix --force`:
the earlier report proposed unrelated Firebase/drizzle downgrades. `npm audit`
reported zero advisories after this update; that is not a full application
security certification or a native dependency scan.
