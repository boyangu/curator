package app.curator.mobile.diag

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class LogStoreTest {
	@get:Rule val tmp = TemporaryFolder()

	private fun rec(msg: String) = buildJsonObject { put("msg", msg) }
	private fun numbers(l: List<JsonObject>) = l.map { it["n"]!!.jsonPrimitive.long }
	private fun store(bytes: Long = 1 shl 20) = LogStore(tmp.root, bytes, 3)

	@Test fun numbersRecordsAndCarriesOnAcrossRuns() {
		val a = store()
		a.append(rec("one"))
		a.append(rec("two"))
		val b = store()
		b.append(rec("three"))
		assertEquals(listOf(0L, 1L, 2L), numbers(b.unsent(10, 1 shl 20)))
		assertEquals(a.installId, b.installId)
	}

	@Test fun sendsEachOnceAndOnlyWhatFits() {
		val s = store()
		repeat(5) { s.append(rec("m$it")) }
		assertEquals(listOf(0L, 1L), numbers(s.unsent(2, 1 shl 20)))
		s.markSent(1)
		assertEquals(listOf(2L, 3L, 4L), numbers(s.unsent(10, 1 shl 20)))
		// One too big for the batch still goes, alone.
		assertEquals(listOf(2L), numbers(s.unsent(10, 1)))
		s.markSent(0)
		assertEquals(1L, s.sent())
		s.skipUnsent()
		assertTrue(s.unsent(10, 1 shl 20).isEmpty())
	}

	@Test fun rotatesWithinItsFilesAndNeverRepeatsANumber() {
		val s = store(bytes = 200)
		repeat(100) { s.append(rec("a line of some length $it")) }
		val logs = tmp.root.listFiles()!!.filter { it.name.endsWith(".log") }
		assertEquals(3, logs.size)
		assertTrue(logs.sumOf { it.length() } < 1_200)
		val left = numbers(s.unsent(1_000, 1 shl 20))
		assertEquals(left.sorted().distinct(), left)
		assertEquals(99L, left.last())
		// Everything sent and rotated away: the numbers still go on.
		s.markSent(99)
		for (l in logs) l.delete()
		val again = store(bytes = 200)
		again.append(rec("next"))
		assertEquals(listOf(100L), numbers(again.unsent(10, 1 shl 20)))
	}

	@Test fun aLineCutByAKillCostsItselfOnly() {
		val s = store()
		s.append(rec("one"))
		File(tmp.root, "phone.log").appendText("{\"n\":1,\"msg\":\"cu")
		val t = store()
		t.append(rec("after"))
		assertEquals(listOf("one", "after"), t.unsent(10, 1 shl 20).map { it["msg"]!!.jsonPrimitive.content })
		val out = File(tmp.root, "out.jsonl")
		t.export(out)
		assertEquals(3, out.readLines().size)
	}

	@Test fun theUploadIsTheWireShapeTheCloudTests() {
		// apps/cloud src/diagnostics.test.ts sends this file.
		val want = Json.parseToJsonElement(javaClass.getResource("/diagnostics-upload.json")!!.readText()).jsonObject
		val records = (want["records"] as kotlinx.serialization.json.JsonArray).map { it.jsonObject }
		fun text(k: String) = (want[k] as JsonPrimitive).content
		assertEquals(want, Json.parseToJsonElement(uploadBody(text("installId"), text("appVersion"), text("device"), records)))
	}
}
