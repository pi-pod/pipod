package com.pipod.app.core.format

import com.pipod.app.core.api.model.Pod

/**
 * One machine (or isolated pod) and the pods that belong under it.
 *
 * Grouping is a fold on the machine first (`hostPodId`) and the launcher
 * (`parentPodId`) only when there is no host — the same edge the CLI uses. A
 * child whose anchor is not in the incoming list is a root, never hidden.
 */
data class PodGroup(val root: Pod, val children: List<Pod> = emptyList()) {

    val members: List<Pod> get() = listOf(root) + children

    val hasChildren: Boolean get() = children.isNotEmpty()

    /**
     * A failed member pulls the whole group up so it cannot hide under a healthy
     * host.
     */
    val needsAttention: Boolean
        get() = members.any { PodPresentation.fromPod(it).lifecycle == PodLifecycle.Failed }
}

/**
 * Groups [pods] without reordering roots: the first time a pod appears as a
 * root, it keeps that place. Children follow their anchor, even if they arrived
 * earlier in the list.
 */
fun groupPods(pods: Iterable<Pod>): List<PodGroup> {
    val list = pods.toList()
    val present = list.mapTo(mutableSetOf()) { it.id }
    val childrenOf = mutableMapOf<String, MutableList<Pod>>()
    val roots = mutableListOf<Pod>()
    for (pod in list) {
        val anchorId = pod.hostPodId ?: pod.parentPodId
        if (anchorId == null || anchorId !in present) {
            roots.add(pod)
            continue
        }
        childrenOf.getOrPut(anchorId) { mutableListOf() }.add(pod)
    }

    // One visual indent under the root: descendants sit beside each other,
    // matching the one-level fold on the machine. Isolated parent/child nests (no
    // host) still appear together rather than as a second tree.
    fun descendants(id: String): List<Pod> {
        val nested = mutableListOf<Pod>()
        fun walk(parentId: String) {
            for (child in childrenOf[parentId].orEmpty()) {
                nested.add(child)
                walk(child.id)
            }
        }
        walk(id)
        return nested
    }

    return roots.map { PodGroup(root = it, children = descendants(it.id)) }
}

/** Failed groups first, relative order otherwise preserved. */
fun attentionFirst(groups: List<PodGroup>): List<PodGroup> =
    groups.filter { it.needsAttention } + groups.filterNot { it.needsAttention }
