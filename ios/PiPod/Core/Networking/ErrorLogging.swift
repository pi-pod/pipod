import Foundation

/// The part of a failure that is safe to write to a log.
///
/// `String(describing:)` on a `URLError` prints the failing URL, and the URLs
/// this app fails on carry a one-shot session ticket in their query string —
/// `wss://…/session?ticket=…`. A device log is readable by anything with the
/// device, syncs to a sysdiagnose, and is attached to bug reports, so nothing
/// that grants access belongs in one. The domain and code are what a diagnosis
/// actually starts from, and they carry nothing.
func logSafeDescription(_ error: Error) -> String {
    let nsError = error as NSError
    return "\(nsError.domain) \(nsError.code)"
}
