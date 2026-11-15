package com.yourerp.mips.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import okhttp3.MediaType.Companion.toMediaType
import java.util.concurrent.TimeUnit

/**
 * Single place for Retrofit/OkHttp wiring + token persistence.
 *
 * Point BASE_URL at YOUR proxy (the one running erp-proxy.js), not at the ERP
 * and not at mips-erp-api directly — the APK must never hold the ERP apiKey.
 */
object ApiClient {

    // Set in build.gradle.kts:  buildConfigField("String","API_BASE_URL","\"https://…\"")
    private const val BASE_URL = com.yourerp.mips.BuildConfig.API_BASE_URL

    @OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
    private val json = Json {
        ignoreUnknownKeys = true   // ERP data grows fields over time — don't crash on them
        explicitNulls = false
        coerceInputValues = true
    }

    @Volatile
    private var retrofit: Retrofit? = null

    fun api(): MipsErpApi {
        return retrofit?.create(MipsErpApi::class.java) ?: synchronized(this) {
            retrofit?.create(MipsErpApi::class.java) ?: build().create(MipsErpApi::class.java)
        }
    }

    private fun build(): Retrofit {
        val logging = HttpLoggingInterceptor().apply {
            // NEVER log bodies in release: they contain personal student data.
            level = if (com.yourerp.mips.BuildConfig.DEBUG) {
                HttpLoggingInterceptor.Level.BASIC
            } else {
                HttpLoggingInterceptor.Level.NONE
            }
        }

        val client = OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            // generous read timeout: the free-tier host cold-starts in ~30-60s
            .readTimeout(75, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .addInterceptor(logging)
            .addInterceptor { chain ->
                // Attach the session token automatically when present.
                val token = TokenStore.token
                val req = if (token.isNullOrBlank()) chain.request() else {
                    chain.request().newBuilder()
                        .header("X-Session-Token", token)
                        .build()
                }
                chain.proceed(req)
            }
            .build()

        return Retrofit.Builder()
            .baseUrl(BASE_URL.trimEnd('/') + "/")
            .client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
    }
}

/**
 * Token storage. Uses EncryptedSharedPreferences so the token is not readable
 * from a rooted device's plain prefs. Initialise [TokenStore.init] in Application.onCreate().
 */
object TokenStore {
    private const val PREFS = "mips_erp_session"
    private const val KEY_TOKEN = "session_token"
    private const val KEY_USER = "user_id"

    private var prefs: android.content.SharedPreferences? = null

    var token: String? = null
        private set

    /** Which user this token belongs to — lets the UI show the right profile. */
    var userId: String? = null
        private set

    fun init(context: Context) {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        prefs = EncryptedSharedPreferences.create(
            context,
            PREFS,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
        token = prefs?.getString(KEY_TOKEN, null)
        userId = prefs?.getString(KEY_USER, null)
    }

    fun saveUserId(id: String) {
        userId = id
        prefs?.edit()?.putString(KEY_USER, id)?.apply()
    }

    fun save(newToken: String) {
        token = newToken
        prefs?.edit()?.putString(KEY_TOKEN, newToken)?.apply()
    }

    fun clear() {
        token = null
        userId = null
        prefs?.edit()?.remove(KEY_TOKEN)?.remove(KEY_USER)?.apply()
    }

    val isLoggedIn: Boolean get() = !token.isNullOrBlank()
}
