package app.curator.mobile.diag

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.ByteArrayOutputStream

class CrashesTest {
	// A tombstone's wire form, as much as the reader walks: fields of the top message.
	private class Proto {
		val out = ByteArrayOutputStream()
		private fun varint(v: Long) {
			var x = v
			while (x and 0x7fL.inv() != 0L) {
				out.write(((x and 0x7f) or 0x80).toInt())
				x = x ushr 7
			}
			out.write(x.toInt())
		}
		fun number(field: Int, v: Long) = apply { varint((field.toLong() shl 3) or 0); varint(v) }
		fun bytes(field: Int, b: ByteArray) = apply { varint((field.toLong() shl 3) or 2); varint(b.size.toLong()); out.write(b) }
		fun text(field: Int, s: String) = bytes(field, s.encodeToByteArray())
		fun fixed32(field: Int) = apply { varint((field.toLong() shl 3) or 5); out.write(ByteArray(4)) }
		fun fixed64(field: Int) = apply { varint((field.toLong() shl 3) or 1); out.write(ByteArray(8)) }
		fun done(): ByteArray = out.toByteArray()
	}

	@Test fun `the abort message is read from among the tombstone's other fields`() {
		val said = "terminating due to uncaught exception of type facebook::jni::JniException: java.lang.ExceptionInInitializerError"
		val tombstone = Proto()
			.number(1, 3).text(2, "google/sdk_gphone64_x86_64/emu64xa:15").number(5, 4865).fixed32(30).fixed64(31)
			// A thread: a message of its own, whose insides are not walked.
			.bytes(16, Proto().number(1, 4903).text(2, "curator-core").done())
			.text(14, "  $said\n")
			.number(20, 59)
			.done()
		assertEquals(said, Crashes.abortMessage(tombstone))
	}

	@Test fun `a crash that said nothing has none`() {
		assertNull(Crashes.abortMessage(Proto().number(1, 3).text(2, "fingerprint").done()))
		assertNull(Crashes.abortMessage(Proto().text(14, "  ").done()))
		assertNull(Crashes.abortMessage(ByteArray(0)))
	}

	@Test fun `bytes that are not a tombstone are not read past their end`() {
		// A length that runs off the end, an unfinished number, a wire type that is none.
		assertNull(Crashes.abortMessage(byteArrayOf(0x72, 0x7f, 0x41)))
		assertNull(Crashes.abortMessage(byteArrayOf(0x08, 0x80.toByte())))
		assertNull(Crashes.abortMessage(byteArrayOf(0x0f)))
		assertNull(Crashes.abortMessage("ABI: 'x86_64'\nsignal 6 (SIGABRT)".encodeToByteArray()))
	}

	@Test fun `a long message is cut`() {
		assertEquals(3_000, Crashes.abortMessage(Proto().text(14, "x".repeat(10_000)).done())!!.length)
	}
}
