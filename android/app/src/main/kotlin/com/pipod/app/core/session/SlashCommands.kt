package com.pipod.app.core.session

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * Where a slash command comes from. Built-ins run directly through app controls
 * or dedicated pi RPC commands; extension, prompt and skill commands are
 * discovered from the pod via `get_commands`.
 */
enum class SlashCommandSource(val wireValue: String, val badgeLabel: String) {
    BUILTIN("builtin", "Built-in"),
    EXTENSION("extension", "Extension"),
    PROMPT("prompt", "Prompt"),
    SKILL("skill", "Skill");

    companion object {
        fun fromWire(value: String?): SlashCommandSource =
            entries.firstOrNull { it.wireValue == value } ?: EXTENSION
    }
}

/** One slash command the reader can invoke from the session composer. */
@Immutable
data class SlashCommand(
    /** Command name without the leading `/`. */
    val name: String,
    val description: String,
    val source: SlashCommandSource,
    /** Short argument usage hint shown beside the name in the picker, e.g. `[instructions]`. */
    val argumentHint: String? = null,
    /** True when the command commonly takes arguments after a space. */
    val acceptsArguments: Boolean = true,
    /** True when executing this command requires a live socket to the pod. */
    val requiresConnection: Boolean = true,
) {
    val displayName: String get() = "/$name"
}

/** A slash command currently executing on the pod, shown in the typing/working indicator. */
@Immutable
data class ActiveSlashCommand(
    val id: String,
    val commandName: String,
    val statusLabel: String,
)

/** Local UI follow-ups triggered by built-in slash commands that operate on app screens or clipboard. */
sealed interface SlashCommandLocalAction {
    data object OpenModelPicker : SlashCommandLocalAction
    data object OpenUsage : SlashCommandLocalAction
    data class CopyLastAssistantReply(val text: String?) : SlashCommandLocalAction
}

/**
 * What the current composer draft means as a slash command.
 *
 * Centralizing parsing, matching and validation here means the palette,
 * validation strip, Send button and command executor always agree about
 * whether a draft is valid, what it will do, or why it cannot run.
 */
sealed interface SlashCommandDraftEvaluation {
    /** Ordinary message text (or a path containing another `/`, like `/etc/hosts`). */
    data object None : SlashCommandDraftEvaluation

    /** Typing `/` or a partial prefix before a space: show matching commands. */
    data class Browsing(
        val query: String,
        val matches: List<SlashCommand>,
    ) : SlashCommandDraftEvaluation

    /**
     * Matches a known command. [matches] stays non-empty while no trailing space
     * has been typed yet and sibling commands share this prefix.
     */
    data class Valid(
        val command: SlashCommand,
        val arguments: String,
        val actionSummary: String,
        val warning: String?,
        val canExecute: Boolean,
        val matches: List<SlashCommand>,
    ) : SlashCommandDraftEvaluation

    /** Starts with `/` followed by a single token that does not match any command. */
    data class Unknown(
        val name: String,
        val suggestions: List<SlashCommand>,
        val isLoadingCatalog: Boolean,
        val isConnected: Boolean,
    ) : SlashCommandDraftEvaluation

    val isSlashInput: Boolean get() = this !is None

    val validCommand: SlashCommand? get() = (this as? Valid)?.command

    val paletteMatches: List<SlashCommand>
        get() = when (this) {
            None -> emptyList()
            is Browsing -> matches
            is Valid -> matches
            is Unknown -> suggestions
        }

    val showsPalette: Boolean
        get() = when (this) {
            None -> false
            is Browsing -> true
            is Valid -> matches.isNotEmpty()
            is Unknown -> suggestions.isNotEmpty()
        }

    /**
     * True when tapping Send should be prevented: either a valid command cannot
     * run right now (disconnected or invalid thinking level), or an unknown slash
     * command was typed after the pod's command catalog finished loading.
     */
    val blocksSend: Boolean
        get() = when (this) {
            None -> false
            is Browsing -> true
            is Valid -> !canExecute
            is Unknown -> true // Never turn an unverified command into a model prompt.
        }
}

/** Built-in commands, remote decoding and draft evaluation. */
object SlashCommandCatalog {
    /**
     * Internal pod-bridge commands registered by the shim for CLI transport;
     * never user-facing. Mirrors `POD_INTERNAL_COMMAND_PREFIX` in the CLI.
     */
    const val INTERNAL_COMMAND_PREFIX = "pod:_"

    /**
     * Built-in pi commands that work cleanly on mobile via dedicated RPC calls
     * or native app controls. Pi's `get_commands` omits built-in commands.
     */
    val builtins: List<SlashCommand> = listOf(
        SlashCommand(
            name = "compact",
            description = "Compact conversation context, optionally with focus instructions",
            source = SlashCommandSource.BUILTIN,
            argumentHint = "[instructions]",
            acceptsArguments = true,
            requiresConnection = true,
        ),
        SlashCommand(
            name = "new",
            description = "Start a fresh session in this pod",
            source = SlashCommandSource.BUILTIN,
            argumentHint = null,
            acceptsArguments = false,
            requiresConnection = true,
        ),
        SlashCommand(
            name = "model",
            description = "Choose a model or switch directly by name",
            source = SlashCommandSource.BUILTIN,
            argumentHint = "[model]",
            acceptsArguments = true,
            requiresConnection = false,
        ),
        SlashCommand(
            name = "thinking",
            description = "Set the thinking level or open the model picker",
            source = SlashCommandSource.BUILTIN,
            argumentHint = "[level]",
            acceptsArguments = true,
            requiresConnection = false,
        ),
        SlashCommand(
            name = "name",
            description = "Rename this session or show its current name",
            source = SlashCommandSource.BUILTIN,
            argumentHint = "[name]",
            acceptsArguments = true,
            requiresConnection = true,
        ),
        SlashCommand(
            name = "session",
            description = "Show session usage, tokens, cost and context",
            source = SlashCommandSource.BUILTIN,
            argumentHint = null,
            acceptsArguments = false,
            requiresConnection = false,
        ),
        SlashCommand(
            name = "copy",
            description = "Copy the last assistant reply to the clipboard",
            source = SlashCommandSource.BUILTIN,
            argumentHint = null,
            acceptsArguments = false,
            requiresConnection = false,
        ),
    )

    /** Decodes `data.commands` from a successful `get_commands` RPC response; null on failure. */
    fun decodeRemote(response: JsonObject): List<SlashCommand>? {
        val success = (response["success"] as? JsonPrimitive)?.booleanOrNull == true
        if (!success) return null
        val data = response["data"] as? JsonObject ?: return null
        val list = data["commands"] as? JsonArray ?: return null

        val seen = HashSet<String>()
        val result = ArrayList<SlashCommand>(list.size)
        for (entry in list) {
            val obj = entry as? JsonObject ?: continue
            val name = (obj["name"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim().orEmpty()
            if (name.isEmpty() || name.startsWith(INTERNAL_COMMAND_PREFIX)) continue
            if (!seen.add(name.lowercase())) continue
            val source = SlashCommandSource.fromWire(
                (obj["source"] as? JsonPrimitive)?.takeIf { it.isString }?.content,
            )
            val description = (obj["description"] as? JsonPrimitive)
                ?.takeIf { it.isString }
                ?.content
                ?.trim()
                .orEmpty()
                .ifEmpty { defaultDescription(source) }
            result += SlashCommand(
                name = name,
                description = description,
                source = source,
                argumentHint = null,
                acceptsArguments = true,
                requiresConnection = true,
            )
        }
        return result.sortedWith(
            compareBy<SlashCommand> { sourceRank(it.source) }
                .thenBy { it.name.lowercase() },
        )
    }

    /** Combines built-in commands with pod-discovered commands. Built-ins stay authoritative. */
    fun merge(remote: List<SlashCommand>): List<SlashCommand> {
        val seen = builtins.mapTo(HashSet()) { it.name.lowercase() }
        val merged = ArrayList<SlashCommand>(builtins.size + remote.size)
        merged.addAll(builtins)
        for (command in remote) {
            if (command.name.startsWith(INTERNAL_COMMAND_PREFIX)) continue
            if (!seen.add(command.name.lowercase())) continue
            merged += command
        }
        return merged
    }

    /** What tapping a command row puts into the composer field. */
    fun insertionText(command: SlashCommand): String =
        if (command.acceptsArguments) "/${command.name} " else "/${command.name}"

    /** Evaluates the current draft text against the active command catalog. */
    fun evaluate(
        draft: String,
        commands: List<SlashCommand>,
        hasLoadedCommands: Boolean,
        isConnected: Boolean,
        availableThinkingLevels: List<String>,
    ): SlashCommandDraftEvaluation {
        val trimmedLeading = draft.trimStart()
        if (!trimmedLeading.startsWith("/")) return SlashCommandDraftEvaluation.None
        val afterSlash = trimmedLeading.drop(1)
        // Paths and slash followed by prose are not commands. A bare slash,
        // even with trailing whitespace, keeps the command menu open.
        if (afterSlash.startsWith('/') ||
            (afterSlash.firstOrNull()?.isWhitespace() == true && afterSlash.isNotBlank())
        ) return SlashCommandDraftEvaluation.None

        val tokenEnd = afterSlash.indexOfFirst { it.isWhitespace() }.let { if (it < 0) afterSlash.length else it }
        val token = afterSlash.substring(0, tokenEnd)
        // File paths like `/etc/hosts` or `/usr/local/bin` contain another `/`.
        if ('/' in token) return SlashCommandDraftEvaluation.None

        val hasWhitespaceAfterToken = tokenEnd < afterSlash.length
        val arguments = if (hasWhitespaceAfterToken) afterSlash.substring(tokenEnd).trim() else ""

        if (token.isEmpty()) {
            return SlashCommandDraftEvaluation.Browsing(query = "", matches = commands)
        }

        val lowered = token.lowercase()
        val exact = commands.firstOrNull { it.name.lowercase() == lowered }
        val matches = matching(lowered, commands)

        if (exact != null) {
            val validation = validate(
                command = exact,
                arguments = arguments,
                isConnected = isConnected,
                availableThinkingLevels = availableThinkingLevels,
            )
            val siblingMatches = if (hasWhitespaceAfterToken) {
                emptyList()
            } else {
                matches.filter { it.name != exact.name }
            }
            val paletteRows = if (siblingMatches.isEmpty()) emptyList() else listOf(exact) + siblingMatches
            return SlashCommandDraftEvaluation.Valid(
                command = exact,
                arguments = arguments,
                actionSummary = validation.summary,
                warning = validation.warning,
                canExecute = validation.canExecute,
                matches = paletteRows,
            )
        }

        if (!hasWhitespaceAfterToken && matches.isNotEmpty()) {
            return SlashCommandDraftEvaluation.Browsing(query = token, matches = matches)
        }

        return SlashCommandDraftEvaluation.Unknown(
            name = token,
            suggestions = closestSuggestions(lowered, commands),
            isLoadingCatalog = isConnected && !hasLoadedCommands,
            isConnected = isConnected,
        )
    }

    private fun defaultDescription(source: SlashCommandSource): String = when (source) {
        SlashCommandSource.BUILTIN -> "Built-in command"
        SlashCommandSource.EXTENSION -> "Run extension command on the pod"
        SlashCommandSource.PROMPT -> "Expand prompt template"
        SlashCommandSource.SKILL -> "Run skill instructions"
    }

    private fun sourceRank(source: SlashCommandSource): Int = when (source) {
        SlashCommandSource.BUILTIN -> 0
        SlashCommandSource.EXTENSION -> 1
        SlashCommandSource.PROMPT -> 2
        SlashCommandSource.SKILL -> 3
    }

    private fun matching(query: String, commands: List<SlashCommand>): List<SlashCommand> {
        if (query.isEmpty()) return commands
        val prefix = ArrayList<SlashCommand>()
        val contains = ArrayList<SlashCommand>()
        for (command in commands) {
            val name = command.name.lowercase()
            if (name.startsWith(query)) {
                prefix += command
            } else if (query in name || query in command.description.lowercase()) {
                contains += command
            }
        }
        return prefix + contains
    }

    private fun closestSuggestions(query: String, commands: List<SlashCommand>): List<SlashCommand> {
        if (query.isEmpty()) return emptyList()
        val direct = matching(query, commands)
        if (direct.isNotEmpty()) return direct.take(4)
        val stem = query.take(maxOf(2, query.length - 2))
        return commands.filter { it.name.lowercase().startsWith(stem) }.take(3)
    }

    private data class ValidationResult(
        val summary: String,
        val warning: String?,
        val canExecute: Boolean,
    )

    private fun validate(
        command: SlashCommand,
        arguments: String,
        isConnected: Boolean,
        availableThinkingLevels: List<String>,
    ): ValidationResult {
        if (command.source == SlashCommandSource.BUILTIN) {
            if (!command.acceptsArguments && arguments.isNotEmpty()) {
                return ValidationResult(command.description, "${command.displayName} doesn’t take arguments.", false)
            }
            if (command.requiresConnection && !isConnected) {
                if (command.name == "name" && arguments.isEmpty()) {
                    return ValidationResult("Show the current session name", null, true)
                }
                return ValidationResult(
                    command.description,
                    "Connect to the pod to run ${command.displayName}.",
                    false,
                )
            }
            return when (command.name) {
                "compact" -> if (arguments.isEmpty()) {
                    ValidationResult("Compacts conversation context on the pod", null, true)
                } else {
                    ValidationResult("Compacts context · focus: “$arguments”", null, true)
                }

                "new" -> ValidationResult("Starts a fresh session and clears pod context", null, true)

                "model" -> if (arguments.isEmpty()) {
                    ValidationResult("Opens the model picker", null, true)
                } else {
                    ValidationResult("Switches model matching “$arguments”", null, true)
                }

                "thinking" -> when {
                    arguments.isEmpty() -> ValidationResult("Opens the model & thinking picker", null, true)
                    availableThinkingLevels.isNotEmpty() &&
                        availableThinkingLevels.none { it.equals(arguments, ignoreCase = true) } -> {
                        val allowed = availableThinkingLevels.joinToString(", ")
                        ValidationResult(
                            command.description,
                            "Unknown thinking level “$arguments”. Available: $allowed.",
                            false,
                        )
                    }

                    else -> ValidationResult("Sets thinking level to ${arguments.lowercase()}", null, true)
                }

                "name" -> if (arguments.isEmpty()) {
                    ValidationResult("Shows the current session name", null, true)
                } else {
                    ValidationResult("Renames this session to “$arguments”", null, true)
                }

                "session" -> ValidationResult("Opens session token usage, cost and context stats", null, true)
                "copy" -> ValidationResult("Copies the latest assistant reply to the clipboard", null, true)
                else -> ValidationResult(command.description, null, true)
            }
        }

        if (!isConnected) {
            return ValidationResult(
                command.description,
                "Connect to the pod to run ${command.displayName}.",
                false,
            )
        }
        return if (arguments.isEmpty()) {
            ValidationResult(command.description, null, true)
        } else {
            ValidationResult("${command.description} · $arguments", null, true)
        }
    }
}
