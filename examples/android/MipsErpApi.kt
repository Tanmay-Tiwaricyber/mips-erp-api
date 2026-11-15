package com.yourerp.mips.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.Query

/**
 * Retrofit interface for your backend proxy (erp-proxy.js).
 *
 * The proxy holds the upstream ERP credentials, so the APK only ever carries an
 * opaque session token — never the ERP apiKey.
 */
interface MipsErpApi {

    // ------------------------------------------------------------------ auth

    @POST("api/erp/login")
    suspend fun login(@Body body: LoginRequest): LoginResponse

    @POST("api/erp/captcha")
    suspend fun captcha(@Body body: CaptchaRequest = CaptchaRequest()): CaptchaResponse

    @POST("api/erp/login-captcha")
    suspend fun loginWithCaptcha(@Body body: CaptchaLoginRequest): LoginResponse

    @POST("api/erp/logout")
    suspend fun logout(@Header("X-Session-Token") token: String): Unit

    // ------------------------------------------------------------------ data

    @GET("api/erp/dashboard")
    suspend fun dashboard(@Header("X-Session-Token") token: String): Envelope<Dashboard>

    @GET("api/erp/student/profile")
    suspend fun profile(@Header("X-Session-Token") token: String): Envelope<Profile>

    @GET("api/erp/student/subjects")
    suspend fun subjects(@Header("X-Session-Token") token: String): Envelope<List<Subject>>

    @GET("api/erp/student/timetable")
    suspend fun timetable(@Header("X-Session-Token") token: String): Envelope<Timetable>

    @GET("api/erp/student/attendance")
    suspend fun attendance(@Header("X-Session-Token") token: String): Envelope<Attendance>

    @GET("api/erp/student/assessment")
    suspend fun assessment(@Header("X-Session-Token") token: String): Envelope<Assessment>

    @GET("api/erp/student/classmates")
    suspend fun classmates(@Header("X-Session-Token") token: String): Envelope<List<Classmate>>

    @GET("api/erp/student/documents")
    suspend fun documents(@Header("X-Session-Token") token: String): Envelope<List<Document>>

    @GET("api/erp/calendar/holidays")
    suspend fun holidays(@Header("X-Session-Token") token: String): Envelope<List<Holiday>>

    @GET("api/erp/notices")
    suspend fun notices(
        @Header("X-Session-Token") token: String,
        @Query("limit") limit: Int = 50,
        @Query("month") month: Int? = null,
        @Query("year") year: Int? = null,
    ): Envelope<NoticesPage>
}

// ---------------------------------------------------------------- envelopes

@Serializable
data class Envelope<T>(
    val ok: Boolean = true,
    val data: T? = null,
)

@Serializable
data class LoginRequest(
    val userId: String? = null,
    val password: String? = null,
    val institute: String? = null,
)

@Serializable
data class CaptchaRequest(val institute: String? = null)

@Serializable
data class CaptchaLoginRequest(
    val sessionId: String,
    val userId: String,
    val password: String,
    val captcha: String,
)

@Serializable
data class LoginResponse(
    val token: String? = null,
    val user: UserInfo? = null,
    val role: String? = null,
    val expiresInSeconds: Long? = null,
    val captchaAttempts: Int? = null,
    val error: ApiError? = null,
    val data: CaptchaResponse? = null,
)

@Serializable
data class CaptchaResponse(
    val sessionId: String? = null,
    /** data:image/jpeg;base64,... — decode the part after the comma */
    val captchaImage: String? = null,
    val ocrGuess: String? = null,
)

@Serializable
data class UserInfo(
    val userId: String? = null,
    val registrationCode: String? = null,
    val profilePicUrl: String? = null,
)

@Serializable
data class ApiError(
    val code: String? = null,
    val message: String? = null,
)

// ---------------------------------------------------------------- models

@Serializable
data class Profile(
    val registrationCode: String? = null,
    val fullName: String? = null,
    val rollNo: String? = null,
    val program: String? = null,
    val branch: String? = null,
    val semester: String? = null,
    val section: String? = null,
    val email: String? = null,
    val mobile: String? = null,
    val isHostelMember: Boolean = false,
    val isTransportMember: Boolean = false,
)

@Serializable
data class Subject(
    val serial: String? = null,
    val name: String? = null,
    val code: String? = null,
    val type: String? = null,
    val syllabusCoverage: String? = null,
    val syllabusUrl: String? = null,
)

@Serializable
data class Timetable(
    val asOf: String? = null,
    val slots: List<String> = emptyList(),
    val days: List<TimetableDay> = emptyList(),
)

@Serializable
data class TimetableDay(
    val day: String? = null,
    val periods: List<Period?> = emptyList(),
)

@Serializable
data class Period(
    val subject: String? = null,
    val code: String? = null,
    val teacher: String? = null,
    val kind: String? = null,
    val slot: String? = null,
    val room: String? = null,
    /** set to "LUNCH" for break columns */
    val type: String? = null,
) {
    val isLunch: Boolean get() = type == "LUNCH"
}

@Serializable
data class Attendance(
    val overall: AttendanceOverall? = null,
    val bySubject: List<SubjectAttendance> = emptyList(),
    val totals: AssessmentTotals? = null,
)

@Serializable
data class AttendanceOverall(
    val percent: Double? = null,
    val present: Int = 0,
    val absent: Int = 0,
    val totalLectures: Int = 0,
    val source: String? = null,
)

@Serializable
data class SubjectAttendance(
    val name: String? = null,
    val code: String? = null,
    val percent: Double? = null,
)

@Serializable
data class Assessment(
    val subjects: List<AssessmentRow> = emptyList(),
    val totals: AssessmentTotals? = null,
)

@Serializable
data class AssessmentRow(
    val serial: Int = 0,
    val name: String? = null,
    val code: String? = null,
    val attendance: String? = null,
    val midSemMarks: String? = null,
    val midSemMax: String? = null,
    val unitTest: String? = null,
)

@Serializable
data class AssessmentTotals(
    val attendancePercent: String? = null,
    val midSemObtained: String? = null,
    val midSemMax: String? = null,
)

@Serializable
data class NoticesPage(
    val count: Int = 0,
    val notices: List<Notice> = emptyList(),
)

@Serializable
data class Notice(
    val id: String? = null,
    val date: String? = null,
    val category: String? = null,
    val isNew: Boolean = false,
    val title: String? = null,
    val html: String? = null,
)

@Serializable
data class Holiday(
    val serial: Int? = null,
    val name: String? = null,
    val dates: String? = null,
)

@Serializable
data class Classmate(
    val name: String? = null,
    val admissionCode: String? = null,
    val email: String? = null,
)

@Serializable
data class Document(
    val title: String? = null,
    val description: String? = null,
    val url: String? = null,
)

@Serializable
data class Dashboard(
    val profile: Panel<Profile>? = null,
    val subjects: Panel<List<Subject>>? = null,
    val assessment: Panel<Assessment>? = null,
    val notices: Panel<List<Notice>>? = null,
    val holidays: Panel<List<Holiday>>? = null,
    val classmates: Panel<List<Classmate>>? = null,
)

@Serializable
data class Panel<T>(
    val ok: Boolean = false,
    val data: T? = null,
    val error: String? = null,
)
