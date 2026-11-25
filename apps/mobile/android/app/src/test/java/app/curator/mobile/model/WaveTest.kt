package app.curator.mobile.model

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class WaveTest {
	// A .cpk whose byte at (sample, group byte) is sample * 16 + that byte.
	private fun cpk(version: Int, channels: Int, n: Int, sps: Int = 100): ByteArray {
		val header = if (version == 1) 20 else 21
		val stride = 3 * (if (version == 3) 2 else 1) * channels
		val b = ByteArray(header + n * stride)
		"CURPEAKS".toByteArray().copyInto(b)
		b[8] = version.toByte()
		b[9] = 3
		if (version > 1) b[10] = channels.toByte()
		val at = if (version == 1) 10 else 11
		b[at] = sps.toByte()
		b[at + 2] = n.toByte()
		for (i in 0 until n) for (k in 0 until stride) b[header + i * stride + k] = (i * 16 + k).toByte()
		return b
	}

	@Test
	fun `a mono v1 file is one channel of peaks`() {
		val p = Peaks.parse(cpk(1, 1, 3))!!
		assertArrayEquals(byteArrayOf(0, 16, 32), p.left.low)
		assertArrayEquals(byteArrayOf(2, 18, 34), p.left.high)
		assertNull(p.right)
		assertNull(p.rms)
	}

	@Test
	fun `a stereo v3 file is peaks and rms per channel`() {
		val p = Peaks.parse(cpk(3, 2, 2))!!
		assertEquals(0, p.left.low[0].toInt())
		assertEquals(3, p.rms!!.low[0].toInt())
		assertEquals(6, p.right!!.low[0].toInt())
		assertEquals(11, p.rightRms!!.high[0].toInt())
		assertEquals(100, p.samplesPerSec)
	}

	@Test
	fun `a file cut short or of another kind is none`() {
		assertNull(Peaks.parse(cpk(3, 2, 4).copyOf(40)))
		assertNull(Peaks.parse(ByteArray(64)))
	}

	private fun ramp(n: Int) = ByteArray(n) { (it * 7 % 251).toByte() }.let { Bands(it, it, it) }

	@Test
	fun `a column is the same wherever its run starts`() {
		// What the big wave's stillness rests on: a tile's column, or a later frame's, is this one.
		val b = ramp(500)
		for (skin in WaveSkin.entries) {
			val whole = columns(b, 0, 120, 3.37, skin)
			val piece = columns(b, 40, 40, 3.37, skin)
			for (i in 4 until 36) assertEquals(whole.bass[40 + i], piece.bass[i], 0f)
		}
	}

	@Test
	fun `a column is the mean of its samples, a part of one by that part, and nothing outside the track`() {
		val b = Bands(byteArrayOf(10, 20, 30, 40), ByteArray(4), ByteArray(4))
		assertArrayEquals(floatArrayOf(0f, 15f, 35f, 0f), columns(b, -1, 4, 2.0, WaveSkin.CURATOR).bass, 0.001f)
		// [0, 1.5): all of 10 and half of 20.
		assertEquals((10 + 10) / 1.5f, columns(b, 0, 1, 1.5, WaveSkin.CURATOR).bass[0], 0.001f)
	}

	@Test
	fun `the style is the desktop's default until one is picked`() {
		assertEquals(WaveSkin.REKORDBOX, WaveSkin.of(null))
		assertEquals(WaveSkin.REKORDBOX, WaveSkin.of("gone"))
		for (s in WaveSkin.entries) assertEquals(s, WaveSkin.of(s.id))
	}

	@Test
	fun `the heat-map's colour says which bands sound`() {
		val s = WaveSkin.TRAKTOR
		assertEquals(0xFFFF0000.toInt(), spectrumColor(s, 0.5f, 0f, 0f))
		assertEquals(0xFFFFFF00.toInt(), spectrumColor(s, 0.5f, 0.5f, 0f))
		assertEquals(0xFFFFFFFF.toInt(), spectrumColor(s, 0.2f, 0.2f, 0.2f))
		assertNull(spectrumColor(s, 0f, 0f, 0f))
	}

	@Test
	fun `a drop and a chorus take the accent, the rest the ramp`() {
		for (s in WaveSkin.entries) {
			assertEquals(s.ramp.accent, s.phrase("drop"))
			assertEquals(s.ramp.accent, s.phrase("Chorus 1"))
			assert(s.phrase("intro").l < s.phrase("build").l)
			assertNotNull(s.phrase("a label to come"))
		}
	}
}
