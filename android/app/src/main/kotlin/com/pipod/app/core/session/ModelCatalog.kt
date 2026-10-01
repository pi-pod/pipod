package com.pipod.app.core.session

import kotlinx.serialization.json.JsonObject

/**
 * A selectable model. Provider and model id, not its display name, are its
 * stable protocol identity — the same model reaches the client under different
 * names from the catalog and from `current`, and treating those as two models
 * would show the picker a duplicate row.
 */
class ModelChoice(val provider: String, val modelId: String, val name: String) {

    val id: String get() = "$provider/$modelId"

    override fun equals(other: Any?): Boolean =
        other is ModelChoice && other.provider == provider && other.modelId == modelId

    override fun hashCode(): Int = 31 * provider.hashCode() + modelId.hashCode()

    override fun toString(): String = "ModelChoice($id, name=$name)"

    companion object {
        fun from(payload: JsonObject?): ModelChoice? {
            val provider = payload?.string("provider")?.trim() ?: return null
            val modelId = payload.string("id")?.trim() ?: return null
            if (provider.isEmpty() || modelId.isEmpty()) return null
            val name = payload.string("name")?.trim().orEmpty()
            return ModelChoice(
                provider = provider,
                modelId = modelId,
                name = name.ifEmpty { modelId },
            )
        }
    }
}

/** Ordering and filtering for the model picker. */
object ModelCatalog {

    /** The current model sorts first and is added when the catalog omits it. */
    fun models(available: List<ModelChoice>, current: ModelChoice?): List<ModelChoice> {
        val seen = mutableSetOf<String>()
        val result = mutableListOf<ModelChoice>()
        for (model in available) if (seen.add(model.id)) result += model
        if (current != null && seen.add(current.id)) result += current
        result.sortWith { left, right ->
            when {
                left == current -> if (right == current) 0 else -1
                right == current -> 1
                else -> {
                    val byName = left.name.lowercase().compareTo(right.name.lowercase())
                    if (byName != 0) byName else left.modelId.lowercase().compareTo(right.modelId.lowercase())
                }
            }
        }
        return result
    }

    fun providers(available: List<ModelChoice>, current: ModelChoice?): List<String> {
        val result = models(available, current).map { it.provider }.toSet().toMutableList()
        result.sort()
        val currentProvider = current?.provider
        if (currentProvider != null && result.remove(currentProvider)) result.add(0, currentProvider)
        return result
    }

    fun modelsIn(
        provider: String,
        query: String,
        available: List<ModelChoice>,
        current: ModelChoice?,
    ): List<ModelChoice> {
        val needle = query.trim().lowercase()
        return models(available, current).filter { model ->
            model.provider == provider &&
                (
                    needle.isEmpty() ||
                        model.name.lowercase().contains(needle) ||
                        model.modelId.lowercase().contains(needle)
                    )
        }
    }

    fun providersMatching(providers: List<String>, query: String): List<String> {
        val needle = query.trim().lowercase()
        if (needle.isEmpty()) return providers
        return providers.filter { it.lowercase().contains(needle) }
    }
}
