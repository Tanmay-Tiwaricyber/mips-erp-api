# Android client for mips-erp-api

Kotlin + **Retrofit + OkHttp + Coroutines**. Drop these files into your app module
(`app/src/main/java/...`) and point `BASE_URL` at your deployed proxy.

```
android/
├── ApiClient.kt        Retrofit/OkHttp setup, auth interceptor, token store
├── MipsErpApi.kt       Retrofit interface — one function per endpoint
├── Models.kt           @Serializable data classes matching openapi.json
├── ErpRepository.kt    repository + Result wrapper (call from ViewModel/WorkManager)
└── ErpViewModel.kt     StateFlow-based ViewModel you can copy straight into a screen
```

## Gradle

`app/build.gradle.kts`:

```kotlin
plugins {
    kotlin("android")
    kotlin("plugin.serialization") version "1.9.24"
}

android {
    compileSdk = 34
    defaultConfig {
        minSdk = 24
        buildConfigField("String", "API_BASE_URL", "\"https://your-api.onrender.com\"")
    }
    buildFeatures { buildConfig = true }
}

dependencies {
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-kotlinx-serialization:2.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // Encrypted token storage (see ApiClient.kt)
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.0")
}
```

## Android manifest

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />

<application
    android:usesCleartextTraffic="false"   <!-- keep HTTPS-only in release -->
    android:networkSecurityConfig="@xml/network_security_config">
```

> **Local testing only:** if you run the API on your PC, use `10.0.2.2` from the
> emulator (not `localhost`) — that's the host loopback alias. Add a debug-only
> `network_security_config.xml` allowing cleartext for `10.0.2.2`, never in release.

## Flow

```
LoginActivity  → ErpViewModel.login(userId, password)
                    └─ POST /api/erp/login          (proxy holds the ERP credentials)
                       → returns short-lived token, stored in EncryptedSharedPreferences
HomeFragment   → ErpViewModel.loadDashboard()
                    └─ GET /api/erp/dashboard, /student/attendance, /student/timetable
```

## Notes

- **Never ship the ERP `apiKey` in the APK.** Call your own proxy; the APK only ever
  holds an opaque session token. An APK can be unpacked and its strings read.
- Login can take 2–6 s because the server may solve the captcha several times
  (~33% per attempt). Set an OkHttp read timeout of **45 s** on the login call only.
- If you prefer the manual captcha UX, call `/captcha` → show the base64 image
  (`BitmapFactory.decodeByteArray`) → post the typed answer to `/login-captcha`.
  A wrong answer returns a fresh image in the error body, so the user just retypes.
- Cache aggressively: timetable/holidays change rarely. A 15-minute in-memory or
  Room cache cuts your API calls (and Render cold starts) dramatically.
- The free Render tier sleeps after 15 min idle → first request of the day takes
  ~30–60 s. Show a "waking up the server…" state on cold start instead of a spinner
  that looks stuck.
