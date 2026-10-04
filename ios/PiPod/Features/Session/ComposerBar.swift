import PhotosUI
import SwiftUI

/// Chat-style input pinned above the keyboard, plus the image staging strip for
/// turns that carry pictures.
///
/// Send stays available while pi is working so a follow-up can queue; Stop only
/// becomes actionable for the turn that can be interrupted, but keeps its place
/// in the bar so the field never resizes under a thumb already moving toward
/// Send.
struct ComposerBar: View {
    let stream: SessionStream
    @Binding var text: String
    let placeholder: String
    let onSend: () -> Void
    let onChooseModel: () -> Void
    let onShowUsage: () -> Void

    /// Images staged for the next turn. Empty is the common case and renders no
    /// strip at all.
    let attachments: [ChatAttachment]
    let onRemoveAttachment: (String) -> Void
    @Binding var pickerItems: [PhotosPickerItem]
    @Binding var showFileImporter: Bool
    let attachError: String?
    let isPicking: Bool

    @FocusState.Binding var isFocused: Bool

    private var canSend: Bool {
        guard !isOverLimit,
              !stream.isModelSwitchInFlight,
              !stream.isThinkingSwitchInFlight
        else { return false }
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !attachments.isEmpty
    }

    /// UTF-16 units, because that is what the server counts: its check is
    /// `text.length > MAX_PROMPT_TEXT_CHARS` in JavaScript, where `length` is
    /// UTF-16 code units. Counting Characters here would let an emoji-heavy
    /// prompt pass the client and be refused by the gateway.
    private var usedChars: Int { text.utf16.count }

    private var remainingChars: Int { ComposerLimits.maxPromptTextChars - usedChars }

    private var isOverLimit: Bool { remainingChars < 0 }

    /// Silent until the limit is in sight. A permanent counter on a composer
    /// whose typical message is two lines would be noise 99.99% of the time.
    private var showsCounter: Bool { remainingChars <= ComposerLimits.counterThreshold }

    var body: some View {
        VStack(spacing: 4) {
            HStack(spacing: 8) {
                ModelPickerButton(
                    model: stream,
                    action: onChooseModel,
                    identifier: "composer.modelPicker"
                )
                .layoutPriority(1)
                Spacer(minLength: 0)
                if let usage = stream.usage.latest, !usage.isEmpty {
                    SessionUsageButton(usage: usage, action: onShowUsage)
                }
            }
            .padding(.horizontal, 4)

            if !attachments.isEmpty || attachError != nil {
                AttachmentStrip(
                    attachments: attachments,
                    error: attachError,
                    onRemove: onRemoveAttachment
                )
            }
            if showsCounter { counterRow }
            HStack(alignment: .bottom, spacing: 4) {
                // Always in place: while a picker is open the control is
                // disabled, so the field never reflows under the thumb.
                //
                // No `photoLibrary:` argument on purpose. Naming the shared
                // library selects the in-process picker, which needs
                // NSPhotoLibraryUsageDescription and a granted authorization —
                // and then hands a "Limited" or denied user an empty sheet. This
                // app only reads the picked item's Data and never touches a
                // PHAsset, so the out-of-process picker does the same job with
                // no prompt, no permission and nothing to be denied.
                PhotosPicker(
                    selection: $pickerItems,
                    maxSelectionCount: ChatAttachmentLimits.maxCount,
                    matching: .images
                ) {
                    Image(systemName: "photo.on.rectangle")
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .disabled(isPicking)
                .foregroundStyle(AppColors.secondaryLabel)
                .accessibilityLabel("Attach image")
                .accessibilityIdentifier("composer.attach")

                // Files, not photos: the document browser reads from the
                // Files locations (including this app's own Documents) with
                // no photo-library involvement at all, so there is an attach
                // path wherever the photo picker cannot present. The button
                // only asks; the fileImporter presentation lives on the
                // session screen's root, where a rebuild of this bar can
                // never take its presenting context with it. Single file
                // per pick: the browser chooses on one tap with nothing to
                // confirm, which is also what makes the path drivable.
                Button {
                    showFileImporter = true
                } label: {
                    Image(systemName: "doc.badge.plus")
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .disabled(isPicking)
                .foregroundStyle(AppColors.secondaryLabel)
                .accessibilityLabel("Attach file")
                .accessibilityIdentifier("composer.attachFile")

                TextField(placeholder, text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    // Prompts to a coding agent are full of commands, flags and
                    // identifiers; autocorrect turns "sudo" into "Audi" and the
                    // agent answers the wrong question.
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .focused($isFocused)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(AppColors.card, in: Capsule())
                    .overlay(Capsule().stroke(AppColors.separator))
                    .accessibilityIdentifier("composer.field")

                if stream.isRunning {
                    if stream.isInterrupting {
                        ProgressView()
                            .controlSize(.small)
                            .frame(width: 44, height: 44)
                            .accessibilityLabel("Stopping the current turn")
                            // The stop is asked for and not yet finished, so
                            // neither this nor the Stop control it replaces is
                            // on screen once the turn is actually over. The
                            // spoken sentence is localizable; this is not.
                            .accessibilityIdentifier("composer.interrupting")
                    } else {
                        Button {
                            stream.interrupt()
                        } label: {
                            Image(systemName: "stop.circle.fill")
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(AppColors.destructive)
                        .disabled(!stream.isConnected)
                        .accessibilityLabel("Interrupt current turn")
                        .accessibilityIdentifier("composer.interrupt")
                    }
                }

                Button(action: onSend) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(canSend ? AppColors.accent : AppColors.secondaryLabel)
                .disabled(!canSend)
                .accessibilityLabel("Send message")
                .accessibilityIdentifier("composer.send")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(AppColors.bar)
    }

    /// What is left, and — past the limit — why Send is off.
    private var counterRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if isOverLimit {
                Text(ComposerLimits.overLimitMessage(by: -remainingChars))
                    .font(.caption)
                    .foregroundStyle(AppColors.destructive)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Spacer(minLength: 0)
            }
            Text(ComposerLimits.remainingLabel(remainingChars))
                .font(.caption.monospacedDigit())
                .foregroundStyle(isOverLimit ? AppColors.destructive : AppColors.secondaryLabel)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            isOverLimit
                ? ComposerLimits.overLimitMessage(by: -remainingChars)
                : "\(remainingChars) characters left"
        )
        .accessibilityIdentifier("composer.remaining")
    }
}

/// The composer's share of the prompt contract.
///
/// The gateway refuses a prompt over `MAX_PROMPT_TEXT_CHARS`
/// (`gateway/stream-fanout.ts`), and a refusal there arrives after the message
/// has been optimistically added to the transcript — so the composer enforces
/// the same number and says so while there is still something to do about it.
enum ComposerLimits {
    /// The gateway's bound, owned by `SessionLimits` so the composer's refusal
    /// and the stream's refusal can never drift apart.
    static let maxPromptTextChars = SessionLimits.maxPromptTextChars
    /// Roughly a screenful of text left — late enough to stay quiet, early
    /// enough that nobody discovers the limit by hitting it.
    static let counterThreshold = 1_000

    static func remainingLabel(_ remaining: Int) -> String {
        remaining < 0 ? "\(-remaining) over" : "\(remaining) left"
    }

    static func overLimitMessage(by excess: Int) -> String {
        """
        This message is \(excess) characters over the \(maxPromptTextChars)-character limit. \
        Shorten it, or send it in two messages.
        """
    }
}

/// Staged thumbnails with per-image removal, plus the latest validation error.
/// Thumbnails are small on purpose: they confirm *what* is staged, while the
/// transcript's own rendering is where the user checks the pictures arrived.
private struct AttachmentStrip: View {
    let attachments: [ChatAttachment]
    let error: String?
    let onRemove: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(attachments) { attachment in
                            thumb(attachment)
                        }
                    }
                    .padding(.top, 10)
                    .padding(.trailing, 10)
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel(stripLabel)
            }
            if let error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(AppColors.destructive)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("Image attachment error, \(error)")
                    .accessibilityIdentifier("composer.attachError")
            }
        }
    }

    private var stripLabel: String {
        if attachments.count == 1 {
            return "1 image attached, \(attachments[0].name)"
        }
        let names = attachments.map(\.name).joined(separator: ", ")
        return "\(attachments.count) images attached, \(names)"
    }

    private func thumb(_ attachment: ChatAttachment) -> some View {
        ZStack(alignment: .topTrailing) {
            AttachmentThumbnail(
                key: attachment.id,
                bytes: attachment.bytes,
                side: 56,
                cornerRadius: 10
            ) {
                Image(systemName: "photo").foregroundStyle(AppColors.secondaryLabel)
            }
            .accessibilityLabel("Attached image, \(attachment.name)")
            .accessibilityAddTraits(.isImage)
            // Stable staging contract. The label carries a file name and is
            // localizable, so it is what a reader hears, not what an
            // acceptance test may depend on.
            .accessibilityIdentifier("composer.attachment")

            Button {
                onRemove(attachment.id)
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(AppColors.label, AppColors.bar)
                    .font(.title3)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .offset(x: 14, y: -14)
            .accessibilityLabel("Remove image, \(attachment.name)")
            .accessibilityIdentifier("composer.removeAttachment")
        }
    }
}

/// Loads picked photo items against the composer budget, keeping the ones that
/// fit and reporting the first refusal so the composer can say what was dropped.
@MainActor
enum ChatAttachmentLoader {
    private static var serial = 0

    static func load(
        _ items: [PhotosPickerItem], existing: [ChatAttachment]
    ) async -> (staged: [ChatAttachment], dropped: ChatAttachmentError?) {
        var staged: [ChatAttachment] = []
        var count = existing.count
        var total = existing.reduce(0) { $0 + $1.sizeBytes }
        var dropped: ChatAttachmentError?

        for item in items {
            // Count first: no I/O at all for a turn that cannot grow.
            guard count < ChatAttachmentLimits.maxCount else {
                dropped = dropped ?? ChatAttachmentError(
                    "A message holds at most \(ChatAttachmentLimits.maxCount) images. "
                        + "Remove one first."
                )
                continue
            }
            let name = displayName(for: item)
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else {
                    dropped = dropped ?? ChatAttachmentError("\(name) could not be read.")
                    continue
                }
                serial += 1
                let attachment = try ChatAttachmentLimits.validate(
                    id: "attach-\(Int(Date().timeIntervalSince1970 * 1000))-\(serial)",
                    name: name,
                    bytes: data,
                    existingCount: count,
                    existingBytes: total
                )
                // Once, here, off the main thread: the strip and the transcript
                // then draw from the cache instead of decoding megabytes inside
                // a `body` that re-runs on every transcript revision.
                await AttachmentThumbnails.prepare(
                    key: attachment.id, bytes: attachment.bytes
                )
                staged.append(attachment)
                count += 1
                total += attachment.sizeBytes
            } catch let error as ChatAttachmentError {
                dropped = dropped ?? error
            } catch {
                dropped = dropped ?? ChatAttachmentError(
                    "Couldn’t attach \(name): \(FriendlyError.message(error))"
                )
            }
        }
        return (staged, dropped)
    }

    /// PhotosUI hands back a supported-content-type list rather than a file
    /// name, so the extension is derived from it; the signature check is still
    /// what decides whether the bytes are really an image.
    private static func displayName(for item: PhotosPickerItem) -> String {
        let identifier = item.supportedContentTypes.first?.preferredFilenameExtension
        return "image.\(identifier ?? "img")"
    }

    /// Files picked through the document browser arrive as security-scoped
    /// URLs, not transferables. The count and byte budgets run on the file
    /// size first, so a multi-gigabyte mis-pick is refused before it is read;
    /// the signature check on the bytes still has the last word, exactly as
    /// on the photo path. The staged name is the file's own.
    static func loadFileURLs(
        _ urls: [URL], existing: [ChatAttachment]
    ) async -> (staged: [ChatAttachment], dropped: ChatAttachmentError?) {
        var staged: [ChatAttachment] = []
        var count = existing.count
        var total = existing.reduce(0) { $0 + $1.sizeBytes }
        var dropped: ChatAttachmentError?

        for url in urls {
            guard count < ChatAttachmentLimits.maxCount else {
                dropped = dropped ?? ChatAttachmentError(
                    "A message holds at most \(ChatAttachmentLimits.maxCount) images. "
                        + "Remove one first."
                )
                continue
            }
            let name = url.lastPathComponent
            do {
                // Security-scoped when it comes from the browser, plain when
                // it comes from anywhere else: access is best-effort either
                // way and the read below is what actually decides. The defer
                // lives inside this do-block (not the loop body), so each
                // URL's access stops when its own iteration finishes rather
                // than being held for the whole batch.
                let accessing = url.startAccessingSecurityScopedResource()
                defer {
                    if accessing { url.stopAccessingSecurityScopedResource() }
                }
                if let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize {
                    try ChatAttachmentLimits.checkBudget(
                        displayName: name, byteLength: size,
                        existingCount: count, existingBytes: total
                    )
                }
                let data = try Data(contentsOf: url)
                serial += 1
                let attachment = try ChatAttachmentLimits.validate(
                    id: "attach-\(Int(Date().timeIntervalSince1970 * 1000))-\(serial)",
                    name: name,
                    bytes: data,
                    existingCount: count,
                    existingBytes: total
                )
                await AttachmentThumbnails.prepare(
                    key: attachment.id, bytes: attachment.bytes
                )
                staged.append(attachment)
                count += 1
                total += attachment.sizeBytes
            } catch let error as ChatAttachmentError {
                dropped = dropped ?? error
            } catch {
                dropped = dropped ?? ChatAttachmentError(
                    "Couldn\u{2019}t attach \(name): \(FriendlyError.message(error))"
                )
            }
        }
        return (staged, dropped)
    }
}
