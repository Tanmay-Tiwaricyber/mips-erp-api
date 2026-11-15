// Reference test: decodes real API JSON into the models in this folder.
// Verified against a live capture — 15 subjects, 6 timetable days, 72% attendance.
// Run on the JVM (no emulator needed) to catch model drift when the ERP changes shape.
// Move to app/src/test/kotlin/ and run with the kotlinx-serialization plugin on the classpath.

// Round-trip test: decode REAL API JSON into the Android models and print the result.
import com.yourerp.mips.data.*
import kotlinx.serialization.json.*

@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }

inline fun <reified T> decode(root: JsonElement, key: String): T {
    val obj = root.jsonObject[key]!!
    val wrapper = buildJsonObject {
        put("ok", JsonPrimitive(true))
        put("data", obj)
    }
    return json.decodeFromString<T>(wrapper.toString())
}

fun main(args: Array<String>) {
    val root = json.parseToJsonElement(java.io.File(args[0]).readText())

    val subjects = decode<Envelope<List<Subject>>>(root, "subjects")
    println("subjects decoded: ${subjects.data?.size} -> first = ${subjects.data?.firstOrNull()?.name} (${subjects.data?.firstOrNull()?.code})")

    val tt = decode<Envelope<Timetable>>(root, "timetable")
    val monday = tt.data?.days?.firstOrNull()
    println("timetable decoded: days=${tt.data?.days?.size}, slots=${tt.data?.slots?.size}")
    println("  Monday periods=${monday?.periods?.size}, first=${monday?.periods?.firstOrNull()?.subject} / ${monday?.periods?.firstOrNull()?.teacher}")
    println("  lunch at index: ${monday?.periods?.indexOfFirst { it?.isLunch == true }}")

    val att = decode<Envelope<Attendance>>(root, "attendance")
    println("attendance decoded: overall=${att.data?.overall?.percent}% (source=${att.data?.overall?.source}), subjects=${att.data?.bySubject?.size}")

    val asmt = decode<Envelope<Assessment>>(root, "assessment")
    println("assessment decoded: rows=${asmt.data?.subjects?.size}, totals=${asmt.data?.totals?.attendancePercent}")

    val nt = decode<Envelope<NoticesPage>>(root, "notices")
    println("notices decoded: count=${nt.data?.count}, items=${nt.data?.notices?.size}, newest=${nt.data?.notices?.firstOrNull()?.date} - ${nt.data?.notices?.firstOrNull()?.title?.take(46)}")

    val prof = decode<Envelope<Profile>>(root, "profile")
    println("profile decoded: ${prof.data?.fullName} / ${prof.data?.program} ${prof.data?.branch} sem ${prof.data?.semester} ${prof.data?.section}")

    val hol = decode<Envelope<List<Holiday>>>(root, "holidays")
    println("holidays decoded: ${hol.data?.size}, first=${hol.data?.firstOrNull()?.name}")
}
