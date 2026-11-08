import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

/// Captures one window's video (NV12) and its app's audio (float32, 48 kHz) via ScreenCaptureKit.
final class WindowCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    var onVideo: ((CVPixelBuffer, CMTime, Double) -> Void)?
    /// Interleaved float32 PCM.
    var onAudio: ((Data, Int, Int) -> Void)?
    var onStop: ((Error?) -> Void)?

    let width: Int
    let height: Int
    private var stream: SCStream?
    private let videoQueue = DispatchQueue(label: "capture.video", qos: .userInteractive)
    private let audioQueue = DispatchQueue(label: "capture.audio", qos: .userInteractive)

    init(window: SCWindow, targetHeight: Int, fps: Int, audio: Bool) throws {
        // Keep aspect, even dimensions (required by the encoder), never upscale beyond the window's pixel size.
        let scale = CGFloat(NSScreenScale.main)
        let srcW = window.frame.width * scale
        let srcH = window.frame.height * scale
        let h = min(CGFloat(targetHeight), srcH)
        let w = srcW * (h / srcH)
        width = max(2, Int(w) & ~1)
        height = max(2, Int(h) & ~1)

        let cfg = SCStreamConfiguration()
        cfg.width = width
        cfg.height = height
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        cfg.queueDepth = 3
        cfg.showsCursor = false
        cfg.scalesToFit = true
        cfg.capturesAudio = audio
        cfg.sampleRate = 48_000
        cfg.channelCount = 2
        cfg.excludesCurrentProcessAudio = true
        let filter = SCContentFilter(desktopIndependentWindow: window)
        super.init()
        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: videoQueue)
        if audio { try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue) }
        stream = s
    }

    func start() async throws {
        try await stream?.startCapture()
    }

    func stop() async {
        try? await stream?.stopCapture()
        stream = nil
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onStop?(error)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sb.isValid else { return }
        switch type {
        case .screen: handleVideo(sb)
        case .audio: handleAudio(sb)
        default: break
        }
    }

    private func handleVideo(_ sb: CMSampleBuffer) {
        // Skip idle/blank frames: only `.complete` frames carry new pixels.
        guard let info = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = info.first?[.status] as? Int, let status = SCFrameStatus(rawValue: raw), status == .complete,
              let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        // Capture latency: time between the compositor's display time and delivery to us.
        var captureMs = 0.0
        if let displayTime = info.first?[.displayTime] as? UInt64 {
            var tb = mach_timebase_info_data_t()
            mach_timebase_info(&tb)
            let nowNs = Double(mach_absolute_time()) * Double(tb.numer) / Double(tb.denom)
            let dispNs = Double(displayTime) * Double(tb.numer) / Double(tb.denom)
            captureMs = max(0, (nowNs - dispNs) / 1e6)
        }
        onVideo?(pb, CMSampleBufferGetPresentationTimeStamp(sb), captureMs)
    }

    private func handleAudio(_ sb: CMSampleBuffer) {
        guard let fmt = CMSampleBufferGetFormatDescription(sb), let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(fmt) else { return }
        let asbd = asbdPtr.pointee
        guard asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0, asbd.mBitsPerChannel == 32 else { return }
        let channels = Int(asbd.mChannelsPerFrame)
        let frames = CMSampleBufferGetNumSamples(sb)
        guard channels > 0, frames > 0 else { return }

        var sizeNeeded = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sb, bufferListSizeNeededOut: &sizeNeeded, bufferListOut: nil, bufferListSize: 0, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
        let ablRaw = UnsafeMutableRawPointer.allocate(byteCount: sizeNeeded, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { ablRaw.deallocate() }
        let abl = ablRaw.bindMemory(to: AudioBufferList.self, capacity: 1)
        var block: CMBlockBuffer?
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sb, bufferListSizeNeededOut: nil, bufferListOut: abl, bufferListSize: sizeNeeded, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &block) == noErr else { return }

        let buffers = UnsafeMutableAudioBufferListPointer(abl)
        var out = [Float](repeating: 0, count: frames * channels)
        let nonInterleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        if nonInterleaved {
            for (c, buf) in buffers.enumerated() where c < channels {
                guard let p = buf.mData?.assumingMemoryBound(to: Float.self) else { continue }
                let n = min(frames, Int(buf.mDataByteSize) / 4)
                for f in 0..<n { out[f * channels + c] = p[f] }
            }
        } else if let p = buffers.first?.mData?.assumingMemoryBound(to: Float.self) {
            let n = min(frames * channels, Int(buffers.first!.mDataByteSize) / 4)
            for i in 0..<n { out[i] = p[i] }
        }
        let data = out.withUnsafeBufferPointer { Data(buffer: $0) } // little-endian on Apple silicon/x86
        onAudio?(data, Int(asbd.mSampleRate), channels)
    }
}

/// Backing scale of the main display without importing AppKit into the whole target.
enum NSScreenScale {
    static var main: Double {
        let id = CGMainDisplayID()
        guard let mode = CGDisplayCopyDisplayMode(id) else { return 2 }
        return Double(mode.pixelWidth) / Double(max(1, mode.width))
    }
}
