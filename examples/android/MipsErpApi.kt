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

    /** Cumulative totals + month-by-month breakdown (the portal's pie chart). */
    @GET("api/erp/student/attendance/summary")
    suspend fun attendanceSummary(
        @Header("X-Session-Token") token: String,
        @Query("month") month: String? = null,
    ): Envelope<AttendanceSummaryReport>

    /** Per-subject totals, optionally scoped to one month. */
    @GET("api/erp/student/attendance/by-subject")
    suspend fun attendanceBySubject(
        @Header("X-Session-Token") token: String,
        @Query("month") month: String? = null,
    ): Envelope<SubjectAttendanceReport>

    /** Every attendance view in one call. */
    @GET("api/erp/student/attendance/complete")
    suspend fun attendanceComplete(
        @Header("X-Session-Token") token: String,
    ): Envelope<AttendanceComplete>

    /** Per-period attendance for one date (null = today). Present / Absent / Not Marked. */
    @GET("api/erp/student/attendance/daily")
    suspend fun dailyAttendance(
        @Header("X-Session-Token") token: String,
        @Query("date") date: String? = null,
    ): Envelope<DailyAttendance>

    /** Daily attendance across a range — max 31 days. */
    @GET("api/erp/student/attendance/daily/history")
    suspend fun attendanceHistory(
        @Header("X-Session-Token") token: String,
        @Query("from") from: String? = null,
        @Query("to") to: String? = null,
    ): Envelope<AttendanceHistory>

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
    /** "present" | "absent" | null (not marked yet) */
    val attendance: String? = null,
    /** ready-to-render label: Present / Absent / Not Marked */
    val attendanceLabel: String? = null,
) {
    val isLunch: Boolean get() = type == "LUNCH"
    val isPresent: Boolean get() = attendance == "present"
    val isAbsent: Boolean get() = attendance == "absent"
    val isNotMarked: Boolean get() = attendanceLabel == "Not Marked"
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
    /** Per-period attendance for the day the ERP considers "today". */
    val todayAttendance: Panel<DailyAttendance>? = null,
)

@Serializable
data class Panel<T>(
    val ok: Boolean = false,
    val data: T? = null,
    val error: String? = null,
)

@Serializable
data class DailyAttendance(
    val date: String? = null,
    val weekday: String? = null,
    val summary: AttendanceSummary = AttendanceSummary(),
    val periods: List<Period> = emptyList(),
    val present: List<AttendanceRef> = emptyList(),
    val absent: List<AttendanceRef> = emptyList(),
    val notMarked: List<AttendanceRef> = emptyList(),
)

@Serializable
data class AttendanceSummary(
    val marked: Int = 0,
    val present: Int = 0,
    val absent: Int = 0,
    val notMarked: Int = 0,
    /** rounded to 1 decimal by the API (e.g. 78.3) — null when nothing is marked */
    val percent: Double? = null,
)

@Serializable
data class AttendanceRef(
    val subject: String? = null,
    val code: String? = null,
)

@Serializable
data class AttendanceHistory(
    val from: String? = null,
    val to: String? = null,
    val daysReturned: Int = 0,
    val totals: AttendanceSummary = AttendanceSummary(),
    val bySubject: List<SubjectDailyTotals> = emptyList(),
    val days: List<DailyAttendance> = emptyList(),
)

@Serializable
data class SubjectDailyTotals(
    val subject: String? = null,
    val code: String? = null,
    val present: Int = 0,
    val absent: Int = 0,
    val marked: Int = 0,
    val percent: Double? = null,
)

// ---------------------------------------------------------------------------
// Attendance report (cumulative / month / per-subject) — the portal's
// "Attendance" pie chart and report grid.
// ---------------------------------------------------------------------------

@Serializable
data class AttendanceSummaryReport(
    /** "cumulative" or "month" */
    val scope: String? = null,
    val month: Int? = null,
    val monthName: String? = null,
    val present: Int = 0,
    val absent: Int = 0,
    val total: Int = 0,
    val percent: Int? = null,
    val byMonth: List<MonthAttendance> = emptyList(),
    val monthsWithLectures: List<String> = emptyList(),
)

@Serializable
data class MonthAttendance(
    val month: Int = 0,
    val monthName: String? = null,
    val present: Int = 0,
    val absent: Int = 0,
    val total: Int = 0,
    val percent: Int? = null,
)

@Serializable
data class SubjectAttendanceRow(
    val name: String? = null,
    val code: String? = null,
    val type: String? = null,
    val present: Int = 0,
    val absent: Int = 0,
    val total: Int = 0,
    val percent: Int? = null,
)

@Serializable
data class SubjectAttendanceReport(
    val scope: String? = null,
    val month: Int? = null,
    val monthName: String? = null,
    val subjects: List<SubjectAttendanceRow> = emptyList(),
    val overall: AttendanceTotals = AttendanceTotals(),
    val byType: AttendanceByType = AttendanceByType(),
)

@Serializable
data class AttendanceTotals(
    val present: Int = 0,
    val absent: Int = 0,
    val total: Int = 0,
    val percent: Int? = null,
)

@Serializable
data class AttendanceByType(
    val theory: List<SubjectAttendanceRow> = emptyList(),
    val lab: List<SubjectAttendanceRow> = emptyList(),
)

@Serializable
data class AttendanceComplete(
    val cumulative: AttendanceTotals = AttendanceTotals(),
    val byMonth: List<MonthAttendance> = emptyList(),
    val monthsWithLectures: List<String> = emptyList(),
    val bySubject: List<SubjectAttendanceRow> = emptyList(),
)

// ---------------------------------------------------------------------------
// eLOGiPay fee portal — a SEPARATE system from the ERP above.
//
// Log in through POST /v1/fees/login to get a `pay_...` token; it is rejected by
// the /v1/student/* endpoints, and an `erp_...` token is rejected here.
// ---------------------------------------------------------------------------

interface FeeApi {
    @POST("v1/fees/login")
    suspend fun login(@Body body: FeeLoginRequest): Envelope<FeeLoginResult>

    @GET("v1/fees/dashboard")
    suspend fun dashboard(@Header("Authorization") bearer: String): Envelope<FeeDashboard>

    @GET("v1/fees/dues")
    suspend fun dues(@Header("Authorization") bearer: String): Envelope<FeeDues>

    @GET("v1/fees/invoices")
    suspend fun invoices(
        @Header("Authorization") bearer: String,
        @Query("type") type: String? = null,
    ): Envelope<FeeInvoicePage>

    @GET("v1/fees/receipts")
    suspend fun receipts(@Header("Authorization") bearer: String): Envelope<FeeReceiptPage>

    @POST("v1/fees/logout")
    suspend fun logout(@Header("Authorization") bearer: String): Envelope<FeeLoggedOut>
}

@Serializable
data class FeeLoginRequest(val enrollmentNo: String, val password: String)

@Serializable
data class FeeLoginResult(
    val apiKey: String,
    val user: FeeUser? = null,
    val system: String? = null,
    val expiresInSeconds: Int = 0,
) {
    /** Ready for the Authorization header. */
    val bearer: String get() = "Bearer $apiKey"
}

@Serializable
data class FeeUser(val enrollmentNo: String? = null, val name: String? = null)

@Serializable
data class FeeInvoiceLine(
    val serial: Int = 0,
    val enrollmentNo: String? = null,
    val studentName: String? = null,
    val branch: String? = null,
    val course: String? = null,
    val session: String? = null,
    val invoiceHead: String? = null,
    /** FEE (charge) | DISCOUNT (waiver) | RECEIPT (payment) | REFUND */
    val invoiceType: String? = null,
    val invoiceDate: String? = null,
    val amount: Long = 0,
    val refundAmount: Long = 0,
    val advanceAmount: Long = 0,
    val receiptAmount: Long = 0,
    val discount: Long = 0,
    /** running balance after this line — do not sum these */
    val balance: Long = 0,
    val institute: String? = null,
) {
    val isCharge: Boolean get() = invoiceType == "FEE"
    val isPayment: Boolean get() = invoiceType == "RECEIPT"
}

@Serializable
data class FeeTotals(
    val invoiceCount: Int = 0,
    val charged: Long = 0,
    val receipts: Long = 0,
    val discounts: Long = 0,
    val refunds: Long = 0,
    val advances: Long = 0,
    /** what is still owed */
    val outstanding: Long = 0,
)

@Serializable
data class FeeHead(
    val head: String? = null,
    val charged: Long = 0,
    val receipts: Long = 0,
    val discounts: Long = 0,
    val refunds: Long = 0,
    val balance: Long = 0,
)

@Serializable
data class FeeDues(
    val student: StudentIdentity? = null,
    val asOf: String? = null,
    val totals: FeeTotals = FeeTotals(),
    val byHead: List<FeeHead> = emptyList(),
    val pendingHeads: List<FeeHead> = emptyList(),
    val settled: Boolean = false,
)

@Serializable
data class StudentIdentity(
    val enrollmentNo: String? = null,
    val name: String? = null,
    val branch: String? = null,
    val course: String? = null,
    val session: String? = null,
    val institute: String? = null,
)

@Serializable
data class FeeInvoicePage(
    val student: StudentIdentity? = null,
    val count: Int = 0,
    val invoices: List<FeeInvoiceLine> = emptyList(),
)

@Serializable
data class FeeReceiptPage(
    val count: Int = 0,
    val receipts: List<FeeReceipt> = emptyList(),
    val note: String? = null,
)

@Serializable
data class FeeReceipt(
    val receiptNo: String? = null,
    val receiptDate: String? = null,
    val instrumentNo: String? = null,
    val instrumentDate: String? = null,
    val payMode: String? = null,
    val amount: Long = 0,
)

@Serializable
data class FeeDashboard(
    val system: String? = null,
    val student: StudentIdentity? = null,
    val asOf: String? = null,
    val dues: FeeDues? = null,
    val byHead: List<FeeHead> = emptyList(),
    val payments: List<FeeInvoiceLine> = emptyList(),
    val paymentsTotal: Long = 0,
    val invoices: List<FeeInvoiceLine> = emptyList(),
)

@Serializable
data class FeeLoggedOut(val loggedOut: Boolean = true)
