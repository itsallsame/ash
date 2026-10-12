package ai.ash.widget

import ai.ash.ui.design.AshTokens

/**
 * What a card says once it has gone stale (its core stopped updating it: the card's `expires_at` passed). It is not cleared: the last
 * picture stays, every colour of it turns to the quiet grey, and it says when it was last true (design/vitals/HANDOFF.md §7).
 * [tag] replaces the time at the top right (a Text whose id ends in `.at`); a narrow layout has no room for it and says [tag22] on its last line.
 */
class Stale(val text3: Tint, val surface3: Tint, val surface2: Tint, val tag: String, val tag22: String) {
    companion object {
        /** Words come from design/vitals/copy.json (`widget.stale_tag`, `widget.stale_22`), kept in strings.xml; [hhmm] is when the card was last updated. */
        fun of(tag: String, tag22: String) = Stale(
            Tint(AshTokens.light.text3, AshTokens.dark.text3), Tint(AshTokens.light.surface3, AshTokens.dark.surface3), Tint(AshTokens.light.surface2, AshTokens.dark.surface2), tag, tag22)
    }
}

object CardStale {
    /** A layout this wide or narrower has no room for the tag beside its content. */
    const val NARROW_DP = 160f

    private val texts = setOf(Lay.TEXT, Lay.TEXT_START, Lay.TEXT_MIDDLE, Lay.TEXT_CLIP)

    /** [root] in grey. Its own background (the card) stays; the boxes inside lose their colour, pictures fade, charts go grey. */
    fun grey(root: VNode, s: Stale, wDp: Float): VNode {
        fun go(v: VNode, top: Boolean): VNode {
            var n = v
            if (n.text != null || n.textColor != null) n = n.copy(textColor = s.text3)
            if (!top && n.bg != null && n.lay != Lay.DIV_H && n.lay != Lay.DIV_V) n = n.copy(bg = s.surface2)
            n = n.copy(tint = n.tint?.let { s.text3 }, image = when (val i = n.image) {
                is Img.Path -> i.copy(tint = s.text3)
                is Img.Chart -> Img.Chart(AshChart.stale(i.chart, s.text3, s.surface3))
                else -> i
            }, alpha = if (n.image is Img.Url) 0.5f else n.alpha)
            if (n.lay in texts && n.id.endsWith(".at") && wDp > NARROW_DP) n = n.copy(text = Styled(s.tag))
            return n.copy(children = n.children.map { go(it, false) }, items = n.items?.map { go(it, false) })
        }
        val out = go(root, true)
        if (wDp > NARROW_DP || out.lay != Lay.COL) return out
        val line = VNode(Lay.TEXT, "stale~22", text = Styled(s.tag22), textSize = 11.5f, textColor = s.text3, width = Dim.Fill, maxLines = 2, margin = floatArrayOf(4f, 0f, 0f, 0f))
        return out.copy(children = out.children + line)
    }
}
