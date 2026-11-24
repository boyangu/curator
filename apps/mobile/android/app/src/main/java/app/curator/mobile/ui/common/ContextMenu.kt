package app.curator.mobile.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T

class MenuItem(val label: String, val onClick: () -> Unit)

/**
 * A long-press menu: a panel just under what was pressed ([belowPx]: its
 * height), a quiet title, then 48dp items. A tap outside or back dismisses it
 * (a focusable popup); an item dismisses it, then acts.
 */
@Composable
fun ContextMenu(title: String?, items: List<MenuItem>, belowPx: Int, onDismiss: () -> Unit) {
	Popup(offset = IntOffset(0, belowPx), onDismissRequest = onDismiss, properties = PopupProperties(focusable = true)) {
		Column(Modifier.widthIn(min = 220.dp).width(IntrinsicSize.Max).background(C.bg2).border(1.dp, C.line).padding(vertical = 4.dp)) {
			title?.let { Line(it, T.label, Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 4.dp)) }
			for (item in items) {
				Row(
					Modifier
						.fillMaxWidth()
						.height(48.dp)
						.clickable(role = Role.Button) { onDismiss(); item.onClick() }
						.padding(horizontal = 16.dp),
					verticalAlignment = Alignment.CenterVertically,
				) { BasicText(item.label, style = T.of(15.sp, color = C.fg)) }
			}
		}
	}
}
