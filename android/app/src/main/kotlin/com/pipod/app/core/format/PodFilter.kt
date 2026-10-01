package com.pipod.app.core.format

import com.pipod.app.core.api.model.Pod
import com.pipod.app.core.api.model.PodTemplate
import java.text.Normalizer

/**
 * What the pod list is showing right now. Kept as a plain value so the rules are
 * testable on their own and the list view stays about presentation.
 *
 * Immutable, and not only on principle: a `data class` with `var` fields is
 * unstable to Compose, which made the whole [PodFilter] — and therefore the pod
 * list state holding it — non-skippable, so every list row recomposed on every
 * state change. Every edit here already went through `copy`.
 */
data class PodFilter(
    val status: PodFilterStatus = PodFilterStatus.Active,
    val project: PodFilterProject = PodFilterProject.Any,
    val environment: PodFilterEnvironment = PodFilterEnvironment.Any,
    val onlyMine: Boolean = false,
    val search: String = "",
) {

    /**
     * The screen's resting state. Search is deliberately not part of it: the
     * search field shows its own text and clears itself, so it never needs a
     * second escape hatch.
     */
    val isDefault: Boolean
        get() = status == PodFilterStatus.Active &&
            project == PodFilterProject.Any &&
            environment == PodFilterEnvironment.Any &&
            !onlyMine

    fun apply(pods: List<Pod>, currentUserId: String? = null): List<Pod> =
        pods.filter { matches(it, currentUserId = currentUserId) }

    fun matches(pod: Pod, currentUserId: String? = null): Boolean {
        if (!status.matches(pod)) return false
        when (val chosenProject = project) {
            PodFilterProject.Any -> Unit
            PodFilterProject.Unassigned -> if (pod.projectName != null) return false
            is PodFilterProject.Named -> if (pod.projectName != chosenProject.name) return false
        }
        when (val chosenEnvironment = environment) {
            PodFilterEnvironment.Any -> Unit
            PodFilterEnvironment.None -> if (pod.templateId != null) return false
            is PodFilterEnvironment.Named ->
                if (pod.templateId != chosenEnvironment.id) return false
        }
        if (onlyMine && currentUserId != null && pod.userId != currentUserId) return false
        return matchesSearch(pod)
    }

    /**
     * One field searches pod names and project names together, and every word has
     * to land somewhere: typing "acme auth" finds the auth pod in the acme
     * project.
     */
    private fun matchesSearch(pod: Pod): Boolean {
        val words = normalized(search).split(' ').filter { it.isNotEmpty() }
        if (words.isEmpty()) return true
        val haystack = normalized(
            "${pod.name} ${pod.projectName ?: ""} ${pod.displayLocation} ${pod.hostPodName ?: ""}",
        )
        return words.all { haystack.contains(it) }
    }

    /**
     * Says what the list is showing while it is showing something other than your
     * work. Every part reuses the filter sheet's option labels verbatim, so the
     * summary chip reads with the same words the sheet offered.
     */
    val summary: String
        get() {
            val parts = mutableListOf(status.label)
            when (val chosenProject = project) {
                PodFilterProject.Any -> Unit
                PodFilterProject.Unassigned -> parts.add("No project")
                is PodFilterProject.Named -> parts.add(chosenProject.name)
            }
            when (val chosenEnvironment = environment) {
                PodFilterEnvironment.Any -> Unit
                PodFilterEnvironment.None -> parts.add("No environment")
                is PodFilterEnvironment.Named -> parts.add("from ${chosenEnvironment.name}")
            }
            if (onlyMine) parts.add("Only my pods")
            return parts.joinToString(" · ")
        }

    companion object {

        fun projects(pods: List<Pod>): List<String> =
            pods.mapNotNull { it.projectName }.toSet().sortedBy { it.lowercase() }

        /**
         * The environments worth offering: the ones these pods actually came from.
         * An environment nobody has launched from would only ever filter the list
         * down to nothing, and a pod whose environment has since been deleted keeps
         * its id — named by that id, so it stays reachable.
         */
        fun environments(pods: List<Pod>, named: List<PodTemplate>): List<PodFilterEnvironment> {
            val names = mutableMapOf<String, String>()
            for (template in named) if (template.id !in names) names[template.id] = template.name
            val ids = pods.mapNotNull { it.templateId }.toSet()
            return ids
                .map { PodFilterEnvironment.Named(id = it, name = names[it] ?: shortId(it)) }
                .sortedBy { it.label.lowercase() }
        }

        /** Names hidden lifecycle groups with the same vocabulary as each pod row. */
        fun statusBreakdown(pods: List<Pod>): String? {
            val counts = mutableMapOf<PodLifecycle, Int>()
            for (pod in pods) {
                val lifecycle = PodPresentation.fromPod(pod).lifecycle
                counts[lifecycle] = (counts[lifecycle] ?: 0) + 1
            }
            val parts = PodLifecycle.entries.mapNotNull { lifecycle ->
                counts[lifecycle]?.let { "$it ${lifecycle.label.lowercase()}" }
            }
            return if (parts.isEmpty()) null else parts.joinToString(" · ")
        }

        private fun shortId(id: String): String = if (id.length <= 8) id else id.substring(0, 8)

        /**
         * Foundation `folding(options: [.caseInsensitive, .diacriticInsensitive])`.
         *
         * Decomposing and dropping the combining marks folds every accented
         * letter, not just the ones somebody remembered to list. The Flutter
         * client uses a hand-written pair of lookup strings instead, and they are
         * misaligned there — four `c`s for three source letters, which shifts
         * every mapping from `è` onward, so `ñ` folds to `l` and a search for
         * "niño" cannot match "nino". That is a bug rather than a behaviour worth
         * matching, and the Flutter client is being retired, so this port folds
         * correctly and the divergence is deliberate.
         */
        private fun normalized(text: String): String {
            val decomposed = Normalizer.normalize(text.lowercase(), Normalizer.Form.NFD)
            val buffer = StringBuilder(decomposed.length)
            for (character in decomposed) {
                if (isCombiningMark(character)) continue
                buffer.append(STROKE_LETTERS[character] ?: character)
            }
            return buffer.toString()
        }

        private fun isCombiningMark(character: Char): Boolean =
            when (Character.getType(character).toByte()) {
                Character.NON_SPACING_MARK,
                Character.COMBINING_SPACING_MARK,
                Character.ENCLOSING_MARK,
                -> true

                else -> false
            }

        /**
         * Letters whose diacritic is a stroke through the glyph rather than a
         * combining mark. Unicode gives these no decomposition, so NFD leaves
         * them alone and they need naming.
         */
        private val STROKE_LETTERS = mapOf(
            'ł' to 'l',
            'ø' to 'o',
            'đ' to 'd',
            'ħ' to 'h',
            'ŧ' to 't',
            'þ' to 'p',
            'ð' to 'd',
        )
    }
}

/**
 * The default is every pod that still needs attention; only archived pods are
 * disclosed separately.
 */
enum class PodFilterStatus {
    Active,
    Archived,
    Failed,
    All,
    ;

    val id: String get() = name.lowercase()

    val label: String
        get() = when (this) {
            Active -> "Current pods"
            Archived -> PodLifecycle.Archived.label
            Failed -> PodLifecycle.Failed.label
            All -> "All pods"
        }

    fun matches(pod: Pod): Boolean {
        val lifecycle = PodPresentation.fromPod(pod).lifecycle
        return when (this) {
            Active -> lifecycle != PodLifecycle.Archived
            Archived -> lifecycle == PodLifecycle.Archived
            Failed -> lifecycle == PodLifecycle.Failed
            All -> true
        }
    }
}

sealed interface PodFilterProject {
    data object Any : PodFilterProject
    data object Unassigned : PodFilterProject
    data class Named(val name: String) : PodFilterProject
}

/**
 * Which environment a pod was launched from. The name travels with the id so the
 * filter can say what it is showing without holding the template list.
 */
sealed interface PodFilterEnvironment {
    val label: String
    val templateId: String?

    data object Any : PodFilterEnvironment {
        override val label: String get() = "All environments"
        override val templateId: String? get() = null
    }

    /** Pods launched from no environment at all — the built-in default. */
    data object None : PodFilterEnvironment {
        override val label: String get() = "No environment"
        override val templateId: String? get() = null
    }

    data class Named(val id: String, val name: String) : PodFilterEnvironment {
        override val label: String get() = name
        override val templateId: String get() = id
    }
}
