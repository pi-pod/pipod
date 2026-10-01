import ImageIO
import SwiftUI
import UIKit

/// Small, cheap previews of attached images.
///
/// A phone photo is 3–6 MiB of JPEG and decodes to tens of megabytes of RGBA.
/// `UIImage(data:)` inside a `body` does that decode on the main thread, and does
/// it again on every re-evaluation — which, during a streaming turn, is every
/// time the transcript revises. Five of those per turn is a visibly stuttering
/// composer and a real chance of a memory-pressure kill.
///
/// So the pixels are read once, at the size they are actually drawn at, off the
/// main thread, and kept. `CGImageSourceCreateThumbnailAtIndex` never
/// materialises the full-size bitmap: it decodes straight to the requested
/// bound, which is the whole reason to use ImageIO here rather than draw a
/// `UIImage` into a smaller context.
enum AttachmentThumbnails {
    /// 72pt is the largest place a thumbnail is drawn (the transcript); 144px
    /// covers that at @2x, and @3x devices scale a hair without anyone noticing
    /// on a 72pt tile. Bigger would just be memory nobody looks at.
    static let maxPixelSize = 144

    /// Bounded and purgeable: a long transcript must not grow this without end,
    /// and a thumbnail is always reproducible from bytes the item still holds.
    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 64
        return cache
    }()

    /// The thumbnail if it has already been made. Safe to call from a `body`:
    /// it is a dictionary lookup, never a decode.
    static func cached(_ key: String) -> UIImage? {
        cache.object(forKey: key as NSString)
    }

    /// The thumbnail, decoding it off the main thread the first time.
    @discardableResult
    static func thumbnail(for key: String, bytes: Data) async -> UIImage? {
        if let hit = cached(key) { return hit }
        guard !bytes.isEmpty else { return nil }
        let image = await Task.detached(priority: .userInitiated) {
            AttachmentThumbnails.downsample(bytes)
        }.value
        if let image { cache.setObject(image, forKey: key as NSString) }
        return image
    }

    /// Decodes `data` to at most `maxPixelSize` on its longest side.
    ///
    /// `kCGImageSourceShouldCache: false` on the source keeps the full-size
    /// bitmap from being built on the way; `…CreateThumbnailFromImageAlways`
    /// makes this work for files with no embedded thumbnail and for embedded
    /// thumbnails that are too small; `…WithTransform` applies the EXIF
    /// orientation, so a photo taken sideways is not shown sideways.
    static func downsample(
        _ data: Data, maxPixelSize: Int = AttachmentThumbnails.maxPixelSize
    ) -> UIImage? {
        guard !data.isEmpty else { return nil }
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else {
            return nil
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, maxPixelSize),
        ]
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(
            source, 0, options as CFDictionary
        ) else { return nil }
        return UIImage(cgImage: thumbnail)
    }

    /// Warms the cache for a freshly staged attachment, so the composer's strip
    /// draws a picture on its first frame instead of a placeholder that pops.
    static func prepare(key: String, bytes: Data) async {
        await thumbnail(for: key, bytes: bytes)
    }
}

/// One attached image, drawn from its downsampled copy.
///
/// Falls back to the caller's placeholder while the first decode is in flight
/// and for bytes that are not a readable image — a picture that cannot be shown
/// is still an attachment that was sent, and the row has to say so.
struct AttachmentThumbnail<Placeholder: View>: View {
    /// Stable per image. The composer's attachment id where there is one, and
    /// the transcript item's id plus position for history rows, which carry no
    /// id of their own.
    private let key: String
    private let bytes: Data
    private let side: CGFloat
    private let cornerRadius: CGFloat
    private let placeholder: () -> Placeholder

    /// Seeded from the cache so a row that scrolls back into view does not
    /// flash its placeholder.
    @State private var image: UIImage?

    init(
        key: String,
        bytes: Data,
        side: CGFloat,
        cornerRadius: CGFloat,
        @ViewBuilder placeholder: @escaping () -> Placeholder
    ) {
        self.key = key
        self.bytes = bytes
        self.side = side
        self.cornerRadius = cornerRadius
        self.placeholder = placeholder
    }

    var body: some View {
        Group {
            if let image = image ?? AttachmentThumbnails.cached(key) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                placeholder()
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
        .overlay(RoundedRectangle(cornerRadius: cornerRadius).stroke(AppColors.separator))
        .task(id: key) {
            guard image == nil else { return }
            image = await AttachmentThumbnails.thumbnail(for: key, bytes: bytes)
        }
    }
}
