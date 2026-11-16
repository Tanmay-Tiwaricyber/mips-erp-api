// Round-trip test for the eLOGiPay fee-portal contract.
//
// Decodes the REAL /v1/fees/dashboard payload into the Android models and checks
// the money adds up, so a wrong field name or a Long-vs-Int mismatch fails loudly
// here instead of showing Rs 0 in the app.
//
//   java -cp "$CP:classes" FeeRoundTripKt /tmp/fees-dashboard.json
package roundtrip

import com.yourerp.mips.data.*
import kotlinx.serialization.json.*

@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
val j = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }

var bad = 0
fun check(name: String, cond: Boolean, detail: String = "") {
    if (cond) println("  ✔ $name${if (detail.isNotEmpty()) " — $detail" else ""}")
    else { bad++; println("  ✘ $name${if (detail.isNotEmpty()) " — $detail" else ""}") }
}

fun main(args: Array<String>) {
    val root = j.parseToJsonElement(java.io.File(args[0]).readText()).jsonObject
    val body = root["data"]?.jsonObject ?: root

    println("\n▸ eLOGiPay fee round-trip\n")

    val dash = j.decodeFromJsonElement<FeeDashboard>(body)
    val student = dash.student
    val totals = dash.dues?.totals ?: FeeTotals()

    println("  student : ${student?.name} (${student?.enrollmentNo})")
    println("  session : ${student?.course} ${student?.branch} ${student?.session}")
    println("  totals  : charged ₹${totals.charged} receipts ₹${totals.receipts} " +
        "discounts ₹${totals.discounts} outstanding ₹${totals.outstanding}")
    dash.byHead.forEach { println("    ${it.head}: ₹${it.charged} - ₹${it.receipts} - ₹${it.discounts} = ₹${it.balance}") }
    println()

    check("dashboard decodes", true, "${dash.invoices.size} invoice lines")
    check("student identity survived", !student?.enrollmentNo.isNullOrBlank(), student?.name ?: "")
    check("outstanding is a non-zero Long", totals.outstanding > 0, "₹${totals.outstanding}")
    check("settled flag matches the balance", dash.dues?.settled == (totals.outstanding <= 0))

    // head-level sums must equal the row-level totals
    check("byHead charged sums to totals",
        dash.byHead.sumOf { it.charged } == totals.charged,
        "₹${dash.byHead.sumOf { it.charged }} vs ₹${totals.charged}")
    check("byHead receipts sums to totals",
        dash.byHead.sumOf { it.receipts } == totals.receipts,
        "₹${dash.byHead.sumOf { it.receipts }} vs ₹${totals.receipts}")

    // line classification
    val fees = dash.invoices.filter { it.isCharge }
    val pay = dash.invoices.filter { it.isPayment }
    check("FEE lines detected", fees.isNotEmpty(), "${fees.size} charges")
    check("RECEIPT lines detected", pay.isNotEmpty(), "${pay.size} payments")
    check("FEE line amounts sum to totals.charged",
        fees.sumOf { it.amount } == totals.charged,
        "₹${fees.sumOf { it.amount }} vs ₹${totals.charged}")
    check("RECEIPT line amounts sum to totals.receipts",
        pay.sumOf { it.receiptAmount } == totals.receipts,
        "₹${pay.sumOf { it.receiptAmount }} vs ₹${totals.receipts}")
    check("payments list matches the RECEIPT lines",
        dash.payments.size == pay.size, "${dash.payments.size} vs ${pay.size}")
    check("paymentsTotal matches the payment lines",
        dash.paymentsTotal == totals.receipts, "₹${dash.paymentsTotal}")

    println(if (bad == 0) "\n✅ all fee round-trip assertions passed" else "\n❌ $bad failed")
    if (bad != 0) kotlin.system.exitProcess(1)
}
