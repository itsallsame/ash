package ai.ash.widget

import ai.ash.ui.design.AshTokens

/**
 * What a card says once it has gone stale (its core stopped updating it: the card's `expires_at` passed). It is not cleared: the last
 * picture stays, every colour of it turns to the quiet grey and the lamp to a plain grey dot, and it says when it was last true
 * (design/vitals/HANDOFF.md §7, and the redlines of the stale widgets). A card names the parts by their ids: a Text whose id ends in `.at`
 * is its time (it becomes the tag [tag], on a pill, in a layout wide enough for it), `.lv` its level word (it becomes [level] in a narrow
 * one, where the tag has no room), `.halo` the soft ring round its lamp (it goes).
 */
class Stale(val text3: Tint, val text2: Tint, val surface3: Tint, val surface2: Tint, val tag: String, val level: String) {
    companion object {
        /** Words come from design/vitals/copy.json (`widget.stale_tag`, `levels.stale.name`), kept in strings.xml; a test keeps them equal. */
        fun of(tag: String, level: String) = Stale(
            Tint(AshTokens.light.text3, AshTokens.dark.text3), Tint(AshTokens.light.text2, AshTokens.dark.text2),
            Tint(AshTokens.light.surface3, AshTokens.dark.surface3), Tint(AshTokens.light.surface2, AshTokens.dark.surface2), tag, level)
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
            }, alpha = when { n.id.endsWith(".halo") -> 0f; n.image is Img.Url -> 0.5f; else -> n.alpha })
            if (n.lay in texts && n.id.endsWith(".at")) {
                if (wDp > NARROW_DP) n = n.copy(text = Styled(s.tag), textColor = s.text2, bg = s.surface2, radius = 10f, padding = floatArrayOf(2f, 8f, 2f, 8f), margin = floatArrayOf(0f, 0f, 0f, 0f))
            }
            if (n.lay in texts && n.id.endsWith(".lv") && wDp <= NARROW_DP) n = n.copy(text = Styled(s.level))
            return n.copy(children = n.children.map { go(it, false) }, items = n.items?.map { go(it, false) })
        }
        return go(root, true)
    }
}
