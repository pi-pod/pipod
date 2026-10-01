import Foundation

/// The session protocol's own bounds, as the gateway enforces them.
///
/// These are not presentation choices: each one is a number the server will
/// refuse traffic over, so the client applies it before the round trip rather
/// than learning it from an `error` frame that leaves a bubble stuck mid-send.
public enum SessionLimits {
    /// `MAX_PROMPT_TEXT_CHARS` in `gateway/stream-fanout.ts`. A prompt longer
    /// than this is rejected by `normalizePromptText`, which answers with an
    /// error frame and no `user_prompt` event.
    public static let maxPromptTextChars = 64 * 1024

    /// `bashSnapshotAccumulate`'s budget in `gateway/readiness.ts`. The gateway
    /// keeps the last 64 KiB of a command's output and replays exactly that
    /// after an attach, so there is nothing to be gained by holding more.
    public static let maxBashOutputChars = 64 * 1024

    /// What the composer says instead of sending a prompt no gateway will take.
    public static let promptTooLongMessage = """
        That message is too long to send (the limit is \(maxPromptTextChars) characters). \
        Shorten it, or put the long part in a file on the pod.
        """

    /// The last `maxBashOutputChars` characters, matching the server's own
    /// accumulator so both ends hold the same window of a long-running command.
    static func tail(_ text: String) -> String {
        guard text.count > maxBashOutputChars else { return text }
        return String(text.suffix(maxBashOutputChars))
    }
}
