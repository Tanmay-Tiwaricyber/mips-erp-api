package com.yourerp.mips.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import retrofit2.HttpException
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/** Domain-level failure the UI can switch on. */
sealed class ErpError(val userMessage: String) {
    object NoNetwork : ErpError("No internet connection. Check your network and try again.")
    object ServerWaking : ErpError("The server is waking up — this can take up to a minute on the free tier.")
    object SessionExpired : ErpError("Your session expired. Please log in again.")
    object BadCredentials : ErpError("Invalid user ID or password.")
    object IncorrectPassword : ErpError("Incorrect password for this user ID.")
    object TooManyAttempts : ErpError("Too many attempts. Please wait a few minutes and try again.")
    object CaptchaFailed : ErpError("Could not verify the captcha. Please try again.")
    data class Unexpected(val detail: String) : ErpError("Something went wrong: $detail")
}

class ErpRepository(
    private val api: MipsErpApi = ApiClient.api(),
) {

    // ------------------------------------------------------------------ auth

    /**
     * Log in as the user who just typed their credentials. The proxy opens a
     * session for THAT user only; we store the opaque token, never the password.
     * Can take 2–10 s because the server may need several captcha attempts.
     */
    suspend fun login(userId: String, password: String): Result<LoginResponse> = safeCall {
        val res = api.login(LoginRequest(userId = userId.trim(), password = password))
        val token = res.token ?: throw ErpFailure(mapLoginError(res.error?.code))
        TokenStore.save(token)
        TokenStore.saveUserId(res.user?.userId ?: userId.trim())
        res
    }

    /** Step 1 of the manual captcha flow. */
    suspend fun requestCaptcha(): Result<CaptchaResponse> = safeCall {
        api.captcha().let { env ->
            // proxy returns the payload either bare or inside data
            env
        }
    }

    /** Step 2 of the manual captcha flow. On a wrong answer the error body carries a fresh image. */
    suspend fun loginWithCaptcha(sessionId: String, userId: String, password: String, answer: String): Result<LoginResponse> =
        safeCall {
            val res = api.loginWithCaptcha(
                CaptchaLoginRequest(sessionId, userId.trim(), password, answer.trim())
            )
            val token = res.token ?: throw ErpFailure(mapLoginError(res.error?.code))
            TokenStore.save(token)
            TokenStore.saveUserId(res.user?.userId ?: userId.trim())
            res
        }

    suspend fun logout() {
        val token = TokenStore.token ?: return
        runCatching { api.logout(token) }
        TokenStore.clear()
    }

    // ------------------------------------------------------------------ data

    suspend fun profile() = safeCall { api.profile(requireToken()).requireData() }
    suspend fun subjects() = safeCall { api.subjects(requireToken()).requireData() }
    suspend fun timetable() = safeCall { api.timetable(requireToken()).requireData() }
    suspend fun attendance() = safeCall { api.attendance(requireToken()).requireData() }
    /** Cumulative attendance + month breakdown (the portal's pie chart). */
    suspend fun attendanceSummary(month: String? = null) =
        safeCall { api.attendanceSummary(requireToken(), month).requireData() }

    /** Per-subject totals, optionally for one month. */
    suspend fun attendanceBySubject(month: String? = null) =
        safeCall { api.attendanceBySubject(requireToken(), month).requireData() }

    /** Every attendance view in one call — use for a full attendance screen. */
    suspend fun attendanceComplete() =
        safeCall { api.attendanceComplete(requireToken()).requireData() }

    /** Per-period attendance for a date (null = today). Drives the daily card. */
    suspend fun dailyAttendance(date: String? = null) =
        safeCall { api.dailyAttendance(requireToken(), date).requireData() }

    /** Daily attendance across a range — the API caps this at 31 days. */
    suspend fun attendanceHistory(from: String? = null, to: String? = null) =
        safeCall { api.attendanceHistory(requireToken(), from, to).requireData() }

    suspend fun assessment() = safeCall { api.assessment(requireToken()).requireData() }
    suspend fun classmates() = safeCall { api.classmates(requireToken()).requireData() }
    suspend fun documents() = safeCall { api.documents(requireToken()).requireData() }
    suspend fun holidays() = safeCall { api.holidays(requireToken()).requireData() }
    suspend fun notices(limit: Int = 50) = safeCall { api.notices(requireToken(), limit).requireData() }
    suspend fun dashboard() = safeCall { api.dashboard(requireToken()).requireData() }

    // ------------------------------------------------------------------ plumbing

    private fun requireToken(): String =
        TokenStore.token ?: throw ErpFailure(ErpError.SessionExpired)

    private fun <T> Envelope<T>.requireData(): T =
        data ?: throw ErpFailure(ErpError.Unexpected("empty response body"))

    private fun mapLoginError(code: String?): ErpError = when (code) {
        "INVALID_CREDENTIALS" -> ErpError.BadCredentials
        // valid user id, wrong password. Do NOT auto-retry: the college ERP
        // e-mails the account's credentials and counts it as a failed attempt.
        "INCORRECT_PASSWORD" -> ErpError.IncorrectPassword
        "INVALID_CAPTCHA", "CAPTCHA_OCR_FAILED", "CAPTCHA_FAILED" -> ErpError.CaptchaFailed
        "ERP_TIMEOUT" -> ErpError.ServerWaking
        "TOO_MANY_ATTEMPTS" -> ErpError.TooManyAttempts
        "SESSION_EXPIRED", "NO_SESSION" -> ErpError.SessionExpired
        else -> ErpError.Unexpected(code ?: "login failed")
    }

    /** Wraps a call, mapping transport/HTTP failures onto [ErpError]. */
    private suspend fun <T> safeCall(block: suspend () -> T): Result<T> = withContext(Dispatchers.IO) {
        try {
            Result.success(block())
        } catch (e: ErpFailure) {
            Result.failure(ErpException(e.error))
        } catch (e: UnknownHostException) {
            Result.failure(ErpException(ErpError.NoNetwork))
        } catch (e: SocketTimeoutException) {
            Result.failure(ErpException(ErpError.ServerWaking))
        } catch (e: IOException) {
            Result.failure(ErpException(ErpError.NoNetwork))
        } catch (e: HttpException) {
            val mapped = when (e.code()) {
                401 -> ErpError.SessionExpired
                504 -> ErpError.ServerWaking
                502, 503 -> ErpError.ServerWaking
                else -> ErpError.Unexpected("HTTP ${e.code()}")
            }
            Result.failure(ErpException(mapped))
        } catch (e: Exception) {
            Result.failure(ErpException(ErpError.Unexpected(e.message ?: e::class.simpleName ?: "unknown")))
        }
    }
}

internal class ErpFailure(val error: ErpError) : Exception(error.userMessage)

/** Throwable you can surface in the UI. */
class ErpException(val error: ErpError) : Exception(error.userMessage)
