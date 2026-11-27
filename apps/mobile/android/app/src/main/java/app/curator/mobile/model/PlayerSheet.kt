package app.curator.mobile.model

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * The player sheet's drag, bar ↔ full player: the sheet follows the finger
 * 1:1, and on release the last direction of travel decides, not the distance
 * (pull it halfway, then slide down, and it closes). The direction is that of
 * the last [step] of movement, so a finger's jitter as it lifts can't turn
 * it; a drag that never went [tapSlop] from where it began is a tap, which
 * opens a closed sheet and closes an open one.
 */
class SheetDrag(private val tapSlop: Float, private val step: Float) {
	private var height = 0f
	private var from = 0f
	private var travel = 0f
	private var furthest = 0f
	private var sinceTurn = 0f
	private var up: Boolean? = null

	/** The sheet's visible height: 0 closed, [height] open. */
	var reveal = 0f
		private set

	fun start(open: Boolean, height: Float) {
		this.height = height
		from = if (open) height else 0f
		reveal = from
		travel = 0f
		furthest = 0f
		sinceTurn = 0f
		up = null
	}

	/** [dy]: the finger's move since the last, down positive. Answers the new [reveal]. */
	fun move(dy: Float): Float {
		travel += dy
		furthest = max(furthest, abs(travel))
		sinceTurn += dy
		if (abs(sinceTurn) >= step) {
			up = sinceTurn < 0
			sinceTurn = 0f
		}
		reveal = (from - travel).coerceIn(0f, height)
		return reveal
	}

	/** Whether it never went far enough to be a drag. */
	val tap: Boolean get() = furthest < tapSlop

	/** Whether the sheet settles open. */
	fun release(): Boolean = if (tap) from == 0f else up ?: (from > 0f)

	companion object {
		/** The dim over what is behind: up to 60% black, with the reveal. */
		fun dim(reveal: Float, height: Float): Float = if (height <= 0f) 0f else min(0.6f, reveal / height * 0.8f)

		/**
		 * How far the bar has turned into the player, 0 to 1: all the way once
		 * the sheet is [MORPH_AT] of the way up. The cover and the names reach
		 * their places on the player by then, and the rest has faded in.
		 */
		fun morph(reveal: Float, height: Float): Float = if (height <= 0f) 1f else (reveal / (height * MORPH_AT)).coerceIn(0f, 1f)

		const val MORPH_AT = 0.2f

		/**
		 * How far the player's title and artists have moved up into its header,
		 * 0 to 1, as its content is scrolled: the title rides up with the
		 * content until it meets its row there, [distance] up, so this is the
		 * scroll over that distance. Follows the finger; nothing animates.
		 */
		fun dock(scroll: Float, distance: Float): Float =
			if (distance <= 0f) (if (scroll > 0f) 1f else 0f) else (scroll / distance).coerceIn(0f, 1f)
	}
}

enum class Axis { UNDECIDED, VERTICAL, HORIZONTAL }

/**
 * Which way a drag goes, decided once it has gone [slop] and then kept: the
 * first pixel deciding is what makes a bar's swipe up misfire as a skip.
 */
class AxisLock(private val slop: Float) {
	private var dx = 0f
	private var dy = 0f

	var axis = Axis.UNDECIDED
		private set

	fun move(x: Float, y: Float): Axis {
		if (axis != Axis.UNDECIDED) return axis
		dx += x
		dy += y
		if (dx * dx + dy * dy >= slop * slop) axis = if (abs(dy) >= abs(dx)) Axis.VERTICAL else Axis.HORIZONTAL
		return axis
	}
}
