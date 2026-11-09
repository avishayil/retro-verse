import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// Low-latency hardware H.264 encoder. Emits AVCC samples plus the avcC record whenever it changes.
final class H264Encoder {
    struct Output {
        let data: Data
        let isKey: Bool
        let ptsMicros: UInt64
        let encodeMs: Double
    }

    var onConfig: ((_ avcC: Data, _ width: Int, _ height: Int) -> Void)?
    var onFrame: ((Output) -> Void)?

    private var session: VTCompressionSession?
    private let width: Int32
    private let height: Int32
    private var lastAvcC: Data?
    private var inFlight = 0
    private let lock = NSLock()
    private var forceKey = true
    private(set) var dropped = 0

    init(width: Int, height: Int, fps: Int, bitrateKbps: Int) throws {
        self.width = Int32(width)
        self.height = Int32(height)
        let spec: [CFString: Any] = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true]
        var s: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: nil, width: self.width, height: self.height, codecType: kCMVideoCodecType_H264,
            encoderSpecification: spec as CFDictionary, imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: nil, refcon: nil, compressionSessionOut: &s)
        guard status == noErr, let session = s else { throw NSError(domain: "H264Encoder", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "VTCompressionSessionCreate failed (\(status))"]) }
        self.session = session
        let props: [CFString: Any] = [
            kVTCompressionPropertyKey_RealTime: true,
            kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_Main_AutoLevel,
            kVTCompressionPropertyKey_AllowFrameReordering: false,
            kVTCompressionPropertyKey_MaxKeyFrameInterval: fps * 2,
            kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: 2.0,
            kVTCompressionPropertyKey_ExpectedFrameRate: fps,
            kVTCompressionPropertyKey_AverageBitRate: bitrateKbps * 1000,
            kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality: true,
        ]
        for (k, v) in props {
            let st = VTSessionSetProperty(session, key: k, value: v as CFTypeRef)
            if st != noErr { Control.log("encoder: property \(k) not supported (\(st))") }
        }
        VTCompressionSessionPrepareToEncodeFrames(session)
    }

    func requestKeyframe() {
        lock.lock(); forceKey = true; lock.unlock()
    }

    /// Encode a frame; drops it (returns false) when the encoder is already two frames behind.
    @discardableResult
    func encode(_ pixelBuffer: CVPixelBuffer, pts: CMTime) -> Bool {
        guard let session else { return false }
        lock.lock()
        if inFlight >= 2 {
            dropped += 1
            lock.unlock()
            return false
        }
        inFlight += 1
        let key = forceKey
        forceKey = false
        lock.unlock()

        let started = CFAbsoluteTimeGetCurrent()
        let props: CFDictionary? = key ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
        let status = VTCompressionSessionEncodeFrame(session, imageBuffer: pixelBuffer, presentationTimeStamp: pts, duration: .invalid, frameProperties: props, infoFlagsOut: nil) { [weak self] status, _, sample in
            guard let self else { return }
            self.lock.lock(); self.inFlight -= 1; self.lock.unlock()
            guard status == noErr, let sample else { return }
            self.handle(sample, encodeMs: (CFAbsoluteTimeGetCurrent() - started) * 1000)
        }
        if status != noErr {
            lock.lock(); inFlight -= 1; lock.unlock()
            Control.log("encoder: encode failed \(status)")
            return false
        }
        return true
    }

    private func handle(_ sample: CMSampleBuffer, encodeMs: Double) {
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let notSync = attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false
        let isKey = !notSync
        if isKey, let fmt = CMSampleBufferGetFormatDescription(sample), let avcC = Self.avcC(from: fmt), avcC != lastAvcC {
            lastAvcC = avcC
            let dims = CMVideoFormatDescriptionGetDimensions(fmt)
            onConfig?(avcC, Int(dims.width), Int(dims.height))
        }
        guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
        var length = 0
        var ptr: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &ptr) == noErr, let ptr else { return }
        let data = Data(bytes: ptr, count: length) // AVCC: 4-byte length-prefixed NAL units
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        let micros = pts.isValid ? UInt64(max(0, CMTimeGetSeconds(pts)) * 1_000_000) : 0
        onFrame?(Output(data: data, isKey: isKey, ptsMicros: micros, encodeMs: encodeMs))
    }

    static func avcC(from fmt: CMFormatDescription) -> Data? {
        guard let ext = CMFormatDescriptionGetExtension(fmt, extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) as? [String: Any] else { return nil }
        return ext["avcC"] as? Data
    }

    func invalidate() {
        if let session {
            VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(session)
        }
        session = nil
    }
}
