package com.pipod.app.core.session

import kotlinx.serialization.json.JsonObject
import android.content.SharedPreferences
import com.pipod.app.core.config.RuntimeConfig
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

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

    /**
     * Every model whose name, provider or id contains each word of [query], in catalog order.
     * Words rather than one substring, so "sol openai" finds a model either way round.
     */
    fun search(query: String, models: List<ModelChoice>): List<ModelChoice> {
        val words = query.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (words.isEmpty()) return models
        return models.filter { model ->
            val haystack = "${model.name} ${model.provider} ${model.modelId}".lowercase()
            words.all { it in haystack }
        }
    }
}

/**
 * Which of a pod's models its user keeps to hand: pi's `enabledModels`, the list `Ctrl+P`
 * cycles through in a terminal.
 *
 * The setting is a list of patterns, and pi resolves each against the catalog. This follows
 * pi's rules closely enough for a picker: a glob matches `provider/id` or the id alone; any
 * other pattern is an exact `provider/id`, else an exact id, else a model whose id or name
 * contains it. A `:level` suffix names a thinking level for the terminal's cycle and is not
 * part of the model. A pattern that matches nothing is skipped: the scope is a convenience,
 * and a stale entry must not hide the models that do match.
 */
object ModelScope {
    private val THINKING_SUFFIX = Regex(":(off|minimal|low|medium|high|xhigh)$")

    fun resolve(patterns: List<String>, models: List<ModelChoice>): List<ModelChoice> {
        val scoped = LinkedHashSet<ModelChoice>()
        for (raw in patterns) {
            val pattern = raw.trim().replace(THINKING_SUFFIX, "").lowercase()
            if (pattern.isEmpty()) continue
            scoped += if (pattern.any { it == '*' || it == '?' }) {
                val glob = globRegex(pattern)
                models.filter { glob.matches(it.id.lowercase()) || glob.matches(it.modelId.lowercase()) }
            } else {
                models.filter { it.id.lowercase() == pattern }
                    .ifEmpty { models.filter { it.modelId.lowercase() == pattern } }
                    .ifEmpty {
                        models.filter { pattern in it.modelId.lowercase() || pattern in it.name.lowercase() }
                    }
            }
        }
        return scoped.toList()
    }

    private fun globRegex(pattern: String): Regex =
        Regex(
            pattern.split('*').joinToString(".*") { part ->
                part.split('?').joinToString(".") { Regex.escape(it) }
            },
        )
}

/**
 * The last model catalog a pod on this server reported, kept so a model can be chosen before
 * the pod it is for has connected.
 *
 * A pod's catalog exists only while its pi is running, which is exactly when nobody needs to
 * wait to choose. One account's pods offer much the same models, so the last catalog seen is
 * what the picker shows until the live one arrives; a choice made from it is applied on
 * connection, and dropped with a note if this pod turns out not to offer it.
 */
object ModelCatalogCache {
    private var prefs: SharedPreferences? = null
    private val key: String get() = "catalog." + RuntimeConfig.serverUrl

    data class Snapshot(
        val models: List<ModelChoice> = emptyList(),
        val thinkingLevels: List<String> = emptyList(),
        val scopePatterns: List<String> = emptyList(),
    )

    fun attach(prefs: SharedPreferences) {
        this.prefs = prefs
    }

    fun read(): Snapshot {
        val raw = prefs?.getString(key, null) ?: return Snapshot()
        return runCatching {
            val root = Json.parseToJsonElement(raw).jsonObject
            Snapshot(
                models = (root["models"] as? JsonArray).orEmpty()
                    .mapNotNull { ModelChoice.from(it as? JsonObject) },
                thinkingLevels = strings(root["thinkingLevels"]),
                scopePatterns = strings(root["scope"]),
            )
        }.getOrDefault(Snapshot())
    }

    fun write(snapshot: Snapshot) {
        val encoded = buildJsonObject {
            putJsonArray("models") {
                for (model in snapshot.models) {
                    addJsonObject {
                        put("provider", model.provider)
                        put("id", model.modelId)
                        put("name", model.name)
                    }
                }
            }
            putJsonArray("thinkingLevels") { snapshot.thinkingLevels.forEach { add(it) } }
            putJsonArray("scope") { snapshot.scopePatterns.forEach { add(it) } }
        }
        prefs?.edit()?.putString(key, encoded.toString())?.apply()
    }

    private fun strings(element: JsonElement?): List<String> =
        (element as? JsonArray).orEmpty()
            .mapNotNull { (it as? JsonPrimitive)?.takeIf { value -> value.isString }?.content }
}
