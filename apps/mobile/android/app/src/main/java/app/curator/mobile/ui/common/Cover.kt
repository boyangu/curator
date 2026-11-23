package app.curator.mobile.ui.common

import android.content.Context
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import app.curator.mobile.ui.theme.oklch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Cover art: the image at a track's or playlist's cover_url (Spotify's CDN,
 * mostly), decoded at the size it is shown, kept in memory and on disk. While
 * it loads, or when there is none, a quiet tile tinted from the id, as the
 * design's placeholders are.
 */
object Covers {
	private val memory = object : LruCache<String, ImageBitmap>(48 * 1024 * 1024) {
		override fun sizeOf(key: String, value: ImageBitmap) = value.width * value.height * 4
	}
	// A list flinging past fifty rows must not open fifty connections.
	private val network = Semaphore(6)

	suspend fun load(context: Context, url: String, px: Int): ImageBitmap? {
		val key = "$px|$url"
		memory.get(key)?.let { return it }
		return withContext(Dispatchers.IO) {
			val dir = File(context.cacheDir, "covers").apply { mkdirs() }
			val file = File(dir, sha1(url))
			if (!file.exists()) {
				val bytes = network.withPermit {
					runCatching {
						val c = URL(url).openConnection() as HttpURLConnection
						c.connectTimeout = 10_000
						c.readTimeout = 20_000
						c.inputStream.use { it.readBytes() }.also { c.disconnect() }
					}.getOrNull()
				} ?: return@withContext null
				val tmp = File(dir, "${file.name}.part")
				tmp.writeBytes(bytes)
				tmp.renameTo(file)
			}
			decode(file, px)?.also { memory.put(key, it) }
		}
	}

	private fun decode(file: File, px: Int): ImageBitmap? {
		val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
		BitmapFactory.decodeFile(file.path, bounds)
		if (bounds.outWidth <= 0) return null
		var sample = 1
		while (bounds.outWidth / (sample * 2) >= px && bounds.outHeight / (sample * 2) >= px) sample *= 2
		return BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
	}

	private fun sha1(s: String) = MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
}

@Composable
fun Cover(url: String?, seed: String, size: Dp, modifier: Modifier = Modifier) {
	val context = LocalContext.current
	val px = with(LocalDensity.current) { size.roundToPx() }
	val image by produceState<ImageBitmap?>(null, url, px) { value = url?.let { Covers.load(context, it, px) } }
	Box(modifier.size(size).background(oklch(0.36f, 0.06f, (seed.hashCode() and 0x7fffffff) % 360f))) {
		image?.let { Image(it, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize()) }
	}
}
