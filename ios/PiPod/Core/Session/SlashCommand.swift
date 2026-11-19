import Foundation

/// Where a slash command comes from. Built-ins are handled directly by the app
/// or dedicated pi RPC commands; extension, prompt and skill commands are
/// discovered from the pod via `get_commands`.
public enum SlashCommandSource: String, Hashable, Sendable {
    case builtin
    case `extension`
    case prompt
    case skill

    public var badgeLabel: String {
        switch self {
        case .builtin: return "Built-in"
        case .extension: return "Extension"
        case .prompt: return "Prompt"
        case .skill: return "Skill"
        }
    }
}

/// One slash command the reader can invoke from the session composer.
public struct SlashCommand: Identifiable, Hashable, Sendable {
    public var id: String { name }
    /// Command name without the leading `/`.
    public let name: String
    public let description: String
    public let source: SlashCommandSource
    /// Short argument usage hint shown beside the name in the picker, e.g. `[instructions]`.
    public let argumentHint: String?
    /// True when the command commonly takes arguments after a space.
    public let acceptsArguments: Bool
    /// True when executing this command requires a live socket to the pod.
    public let requiresConnection: Bool

    public init(
        name: String,
        description: String,
        source: SlashCommandSource,
        argumentHint: String? = nil,
        acceptsArguments: Bool = true,
        requiresConnection: Bool = true
    ) {
        self.name = name
        self.description = description
        self.source = source
        self.argumentHint = argumentHint
        self.acceptsArguments = acceptsArguments
        self.requiresConnection = requiresConnection
    }

    public var displayName: String { "/\(name)" }
}

/// A slash command currently executing on the pod, shown in the session's
/// working indicator so the reader always knows what is happening.
public struct ActiveSlashCommand: Equatable, Sendable {
    public let id: String
    public let commandName: String
    public let statusLabel: String

    public init(id: String, commandName: String, statusLabel: String) {
        self.id = id
        self.commandName = commandName
        self.statusLabel = statusLabel
    }
}

/// Local UI follow-ups triggered by built-in slash commands that operate on
/// app screens or the device clipboard rather than the pod alone.
public enum SlashCommandLocalAction: Equatable, Sendable {
    case openModelPicker
    case openUsage
    case copyLastAssistantReply(String?)
}

/// What the current composer draft means as a slash command.
///
/// Centralizing parsing, matching and validation here means the palette,
/// validation banner, Send button and command executor always agree about
/// whether a draft is a valid command, what it will do, or why it cannot run.
public enum SlashCommandDraftEvaluation: Equatable, Sendable {
    /// Ordinary message text (or a path containing another `/`, like `/etc/hosts`).
    case none
    /// Typing `/` or a partial prefix before a space: show matching commands.
    case browsing(query: String, matches: [SlashCommand])
    /// Matches a known command. `matches` stays non-empty while no trailing space
    /// has been typed yet so closely named siblings remain discoverable.
    case valid(
        command: SlashCommand,
        arguments: String,
        actionSummary: String,
        warning: String?,
        canExecute: Bool,
        matches: [SlashCommand]
    )
    /// Starts with `/` followed by a single token that does not match any command.
    case unknown(
        name: String,
        suggestions: [SlashCommand],
        isLoadingCatalog: Bool,
        isConnected: Bool
    )

    public var isSlashInput: Bool {
        if case .none = self { return false }
        return true
    }

    public var validCommand: SlashCommand? {
        if case .valid(let command, _, _, _, _, _) = self { return command }
        return nil
    }

    public var paletteMatches: [SlashCommand] {
        switch self {
        case .none:
            return []
        case .browsing(_, let matches):
            return matches
        case .valid(_, _, _, _, _, let matches):
            return matches
        case .unknown(_, let suggestions, _, _):
            return suggestions
        }
    }

    public var showsPalette: Bool {
        switch self {
        case .none:
            return false
        case .browsing:
            return true
        case .valid(_, _, _, _, _, let matches):
            return !matches.isEmpty
        case .unknown(_, let suggestions, _, _):
            return !suggestions.isEmpty
        }
    }

    /// True when tapping Send should be prevented: either a valid command cannot
    /// run right now (e.g. disconnected or invalid thinking level), or an unknown
    /// slash command was typed after the pod's command catalog finished loading.
    public var blocksSend: Bool {
        switch self {
        case .none:
            return false
        case .browsing:
            return true
        case .valid(_, _, _, _, let canExecute, _):
            return !canExecute
        case .unknown:
            // Never turn an unverified command into a model prompt.
            return true
        }
    }
}

/// Built-in commands, remote decoding and draft evaluation.
public enum SlashCommandCatalog {
    /// Internal pod-bridge commands registered by the shim for CLI transport;
    /// never user-facing. Mirrors `POD_INTERNAL_COMMAND_PREFIX` in the CLI.
    public static let internalCommandPrefix = "pod:_"

    /// Built-in pi commands that work cleanly on mobile via dedicated RPC calls
    /// or native app controls. Pi's `get_commands` omits built-in commands.
    public static let builtins: [SlashCommand] = [
        SlashCommand(name: "summaries", description: "Summarize bash commands and output with OpenAI GPT-6 Luna (uses your pod’s model quota)", source: .builtin, argumentHint: "[on|off]", requiresConnection: false),
        SlashCommand(
            name: "compact",
            description: "Compact conversation context, optionally with focus instructions",
            source: .builtin,
            argumentHint: "[instructions]",
            acceptsArguments: true,
            requiresConnection: true
        ),
        SlashCommand(
            name: "new",
            description: "Start a fresh session in this pod",
            source: .builtin,
            argumentHint: nil,
            acceptsArguments: false,
            requiresConnection: true
        ),
        SlashCommand(
            name: "model",
            description: "Choose a model or switch directly by name",
            source: .builtin,
            argumentHint: "[model]",
            acceptsArguments: true,
            requiresConnection: false
        ),
        SlashCommand(
            name: "thinking",
            description: "Set the thinking level or open the model picker",
            source: .builtin,
            argumentHint: "[level]",
            acceptsArguments: true,
            requiresConnection: false
        ),
        SlashCommand(
            name: "name",
            description: "Rename this session or show its current name",
            source: .builtin,
            argumentHint: "[name]",
            acceptsArguments: true,
            requiresConnection: true
        ),
        SlashCommand(
            name: "session",
            description: "Show session usage, tokens, cost and context",
            source: .builtin,
            argumentHint: nil,
            acceptsArguments: false,
            requiresConnection: false
        ),
        SlashCommand(
            name: "copy",
            description: "Copy the last assistant reply to the clipboard",
            source: .builtin,
            argumentHint: nil,
            acceptsArguments: false,
            requiresConnection: false
        ),
    ]

    /// Decodes `data.commands` from a successful `get_commands` RPC response.
    /// Returns nil when the response was unsuccessful or malformed.
    public static func decodeRemote(from response: JSONValue) -> [SlashCommand]? {
        guard response["success"]?.boolValue == true,
              let list = response["data"]?["commands"]?.arrayValue
        else { return nil }

        var seen = Set<String>()
        var result: [SlashCommand] = []
        for entry in list {
            guard let rawName = entry["name"]?.stringValue else { continue }
            let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty,
                  !name.hasPrefix(internalCommandPrefix),
                  seen.insert(name.lowercased()).inserted
            else { continue }
            let source = SlashCommandSource(rawValue: entry["source"]?.stringValue ?? "") ?? .extension
            let description = (entry["description"]?.stringValue ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            result.append(
                SlashCommand(
                    name: name,
                    description: description.isEmpty ? defaultDescription(for: source) : description,
                    source: source,
                    argumentHint: nil,
                    acceptsArguments: true,
                    requiresConnection: true
                )
            )
        }
        return result.sorted { lhs, rhs in
            let lOrder = sourceRank(lhs.source)
            let rOrder = sourceRank(rhs.source)
            if lOrder != rOrder { return lOrder < rOrder }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }

    /// Combines built-in commands with pod-discovered commands. Built-ins stay
    /// authoritative when a name collides.
    public static func merge(remote: [SlashCommand]) -> [SlashCommand] {
        var seen = Set(builtins.map { $0.name.lowercased() })
        var merged = builtins
        for command in remote {
            guard !command.name.hasPrefix(internalCommandPrefix),
                  seen.insert(command.name.lowercased()).inserted
            else { continue }
            merged.append(command)
        }
        return merged
    }

    /// What tapping a command row puts into the composer field.
    /// Commands that accept arguments append a trailing space so the user can
    /// type args immediately or tap Send; zero-arg commands stop at `/name`.
    public static func insertionText(for command: SlashCommand) -> String {
        command.acceptsArguments ? "/\(command.name) " : "/\(command.name)"
    }

    /// Evaluates the current draft text against the active command catalog.
    public static func evaluate(
        draft: String,
        commands: [SlashCommand],
        hasLoadedCommands: Bool,
        isConnected: Bool,
        availableThinkingLevels: [String]
    ) -> SlashCommandDraftEvaluation {
        let trimmedLeading = draft.drop(while: \.isWhitespace)
        guard trimmedLeading.first == "/" else { return .none }
        let afterSlash = trimmedLeading.dropFirst()
        // Paths and slash followed by prose are not commands. A bare slash,
        // even with trailing whitespace, keeps the command menu open.
        if afterSlash.first == "/" { return .none }
        if afterSlash.first?.isWhitespace == true,
           afterSlash.contains(where: { !$0.isWhitespace }) { return .none }

        let tokenEnd = afterSlash.firstIndex(where: { $0.isWhitespace }) ?? afterSlash.endIndex
        let token = String(afterSlash[..<tokenEnd])
        // File paths like `/etc/hosts` or `/Users/me/file` contain another `/`.
        if token.contains("/") { return .none }

        let hasWhitespaceAfterToken = tokenEnd < afterSlash.endIndex
        let rawArgs = hasWhitespaceAfterToken ? String(afterSlash[tokenEnd...]) : ""
        let arguments = rawArgs.trimmingCharacters(in: .whitespacesAndNewlines)

        // Bare `/` opens the full catalog.
        if token.isEmpty {
            return .browsing(query: "", matches: commands)
        }

        let lowered = token.lowercased()
        let exact = commands.first { $0.name.lowercased() == lowered }
        let matches = matching(query: lowered, in: commands)

        if let command = exact {
            let validation = validate(
                command: command,
                arguments: arguments,
                isConnected: isConnected,
                availableThinkingLevels: availableThinkingLevels
            )
            // Keep the palette open only while the user is still on the command
            // token and there are sibling commands sharing this prefix (e.g.
            // `/pod` vs `/pod:info`). Once they type a space, switch cleanly to
            // the compact validation bar.
            let siblingMatches = hasWhitespaceAfterToken ? [] : matches.filter { $0.id != command.id }
            let paletteRows = siblingMatches.isEmpty ? [] : [command] + siblingMatches
            return .valid(
                command: command,
                arguments: arguments,
                actionSummary: validation.summary,
                warning: validation.warning,
                canExecute: validation.canExecute,
                matches: paletteRows
            )
        }

        // Still typing the command name (no space yet) and there are matches:
        // show the filtered command palette.
        if !hasWhitespaceAfterToken, !matches.isEmpty {
            return .browsing(query: token, matches: matches)
        }

        // No exact match (and either a space was typed or zero commands match).
        let suggestions = closestSuggestions(for: lowered, in: commands)
        return .unknown(
            name: token,
            suggestions: suggestions,
            isLoadingCatalog: isConnected && !hasLoadedCommands,
            isConnected: isConnected
        )
    }

    // MARK: - Helpers

    private static func defaultDescription(for source: SlashCommandSource) -> String {
        switch source {
        case .builtin: return "Built-in command"
        case .extension: return "Run extension command on the pod"
        case .prompt: return "Expand prompt template"
        case .skill: return "Run skill instructions"
        }
    }

    private static func sourceRank(_ source: SlashCommandSource) -> Int {
        switch source {
        case .builtin: return 0
        case .extension: return 1
        case .prompt: return 2
        case .skill: return 3
        }
    }

    private static func matching(query: String, in commands: [SlashCommand]) -> [SlashCommand] {
        guard !query.isEmpty else { return commands }
        var prefix: [SlashCommand] = []
        var contains: [SlashCommand] = []
        for command in commands {
            let name = command.name.lowercased()
            if name.hasPrefix(query) {
                prefix.append(command)
            } else if name.contains(query) || command.description.lowercased().contains(query) {
                contains.append(command)
            }
        }
        return prefix + contains
    }

    private static func closestSuggestions(for query: String, in commands: [SlashCommand]) -> [SlashCommand] {
        guard !query.isEmpty else { return [] }
        let direct = matching(query: query, in: commands)
        if !direct.isEmpty { return Array(direct.prefix(4)) }
        // Prefix-of-prefix fallback for typos like `/compct` -> `/compact`.
        let stem = String(query.prefix(max(2, query.count - 2)))
        return Array(commands.filter { $0.name.lowercased().hasPrefix(stem) }.prefix(3))
    }

    private static func validate(
        command: SlashCommand,
        arguments: String,
        isConnected: Bool,
        availableThinkingLevels: [String]
    ) -> (summary: String, warning: String?, canExecute: Bool) {
        if command.source == .builtin {
            if !command.acceptsArguments && !arguments.isEmpty {
                return (command.description, "\(command.displayName) doesn’t take arguments.", false)
            }
            if command.requiresConnection && !isConnected {
                // `/name` with no args only reads the current name locally.
                if command.name == "name" && arguments.isEmpty {
                    return ("Show the current session name", nil, true)
                }
                return (
                    command.description,
                    "Connect to the pod to run \(command.displayName).",
                    false
                )
            }
            switch command.name {
            case "summaries":
                if !["", "on", "off"].contains(arguments.lowercased()) { return (command.description, "Use /summaries on or /summaries off.", false) }
                return (command.description, nil, true)
            case "compact":
                if arguments.isEmpty {
                    return ("Compacts conversation context on the pod", nil, true)
                }
                return ("Compacts context · focus: “\(arguments)”", nil, true)
            case "new":
                return ("Starts a fresh session and clears pod context", nil, true)
            case "model":
                if arguments.isEmpty {
                    return ("Opens the model picker", nil, true)
                }
                return ("Switches model matching “\(arguments)”", nil, true)
            case "thinking":
                if arguments.isEmpty {
                    return ("Opens the model & thinking picker", nil, true)
                }
                if !availableThinkingLevels.isEmpty,
                   !availableThinkingLevels.contains(where: { $0.caseInsensitiveCompare(arguments) == .orderedSame }) {
                    let allowed = availableThinkingLevels.joined(separator: ", ")
                    return (
                        command.description,
                        "Unknown thinking level “\(arguments)”. Available: \(allowed).",
                        false
                    )
                }
                return ("Sets thinking level to \(arguments.lowercased())", nil, true)
            case "name":
                if arguments.isEmpty {
                    return ("Shows the current session name", nil, true)
                }
                return ("Renames this session to “\(arguments)”", nil, true)
            case "session":
                return ("Opens session token usage, cost and context stats", nil, true)
            case "copy":
                return ("Copies the latest assistant reply to the clipboard", nil, true)
            default:
                return (command.description, nil, true)
            }
        }

        // Pod-discovered command (extension, prompt template or skill).
        if !isConnected {
            return (
                command.description,
                "Connect to the pod to run \(command.displayName).",
                false
            )
        }
        if arguments.isEmpty {
            return (command.description, nil, true)
        }
        return ("\(command.description) · \(arguments)", nil, true)
    }
}
