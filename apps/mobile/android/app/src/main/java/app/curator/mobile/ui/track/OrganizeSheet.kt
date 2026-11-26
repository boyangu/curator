package app.curator.mobile.ui.track

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.ui.Organize
import app.curator.mobile.ui.common.Cover
import app.curator.mobile.ui.common.Line
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T

/**
 * Organize, opened by long-pressing a heart: tags and add-to-playlist will
 * live here. For now its frame: the track's line, a placeholder, and Done.
 */
@Composable
fun OrganizeSheet(o: Organize, close: () -> Unit) {
	BackHandler(onBack = close)
	Box(Modifier.fillMaxSize()) {
		Box(
			Modifier
				.fillMaxSize()
				.background(Color.Black.copy(alpha = 0.55f))
				.clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, role = Role.Button, onClickLabel = "Close organize", onClick = close),
		)
		Column(
			Modifier
				.align(Alignment.BottomCenter)
				.fillMaxWidth()
				.background(C.bg1)
				.drawBehind { drawLine(C.line, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
				.windowInsetsPadding(WindowInsets.navigationBars)
				.heightIn(min = 360.dp)
				.padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 34.dp)
				.semantics { paneTitle = "Organize ${o.title}" },
			verticalArrangement = Arrangement.spacedBy(12.dp),
		) {
			Box(Modifier.align(Alignment.CenterHorizontally).width(36.dp).height(4.dp).background(C.fg4, RoundedCornerShape(2.dp)))
			Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
				Cover(o.coverUrl, o.seed, 40.dp)
				Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
					BasicText("Organize", style = T.of(15.sp, 500, C.fg))
					Line(listOf(o.title, o.artist).filter { it.isNotEmpty() }.joinToString(" · "), T.of(12.5.sp, color = C.fg2))
				}
				Box(
					Modifier.height(44.dp).clickable(role = Role.Button, onClick = close).padding(horizontal = 4.dp),
					contentAlignment = Alignment.Center,
				) { BasicText("Done", style = T.of(14.sp, 500, C.accent)) }
			}
			Column(
				Modifier
					.fillMaxWidth()
					.weight(1f, fill = false)
					.heightIn(min = 220.dp)
					.drawBehind {
						drawRect(C.fg4, style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))))
					}
					.padding(16.dp)
					.semantics(mergeDescendants = true) { contentDescription = "Placeholder. Tags and add-to-playlist go here." },
				verticalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterVertically),
				horizontalAlignment = Alignment.CenterHorizontally,
			) {
				BasicText("Placeholder", style = T.of(14.sp, color = C.fg))
				BasicText("Tags and add-to-playlist go here.", style = T.of(13.sp, color = C.fg2).copy(textAlign = TextAlign.Center))
			}
		}
	}
}
