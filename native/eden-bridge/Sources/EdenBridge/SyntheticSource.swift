import CoreMedia
import CoreVideo
import EdenBridgeCore
import Foundation

/// Test source used by `--synthetic`: renders NV12 frames (moving bar; background red while A is held,
/// green while Start is held, otherwise blue) and a 440 Hz tone. Lets the encoder, server, webview decoder
/// and the input return path be verified without Screen Recording permission or an emulator.
final class SyntheticSource {
    var onVideo: ((CVPixelBuffer, CMTime, Double) -> Void)?
    var onAudio: ((Data, Int, Int) -> Void)?
    let width: Int
    let height: Int
    private let fps: Int
    private var frame = 0
    private var phase = 0.0
    private var timer: DispatchSourceTimer?
    private var audioTimer: DispatchSourceTimer?
    private let lock = NSLock()
    private var held = Set<String>()
    private var pool: CVPixelBufferPool?

    init(height: Int, fps: Int) {
        self.height = height & ~1
        self.width = (height * 16 / 9) & ~1
        self.fps = fps
        let attrs: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferWidthKey: width, kCVPixelBufferHeightKey: self.height,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
        ]
        CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &pool)
    }

    func setInput(_ s: InputState) {
        lock.lock(); held = activeInputs(s); lock.unlock()
    }

    func start() {
        let q = DispatchQueue(label: "synthetic", qos: .userInteractive)
        let t = DispatchSource.makeTimerSource(queue: q)
        t.schedule(deadline: .now(), repeating: 1.0 / Double(fps))
        t.setEventHandler { [weak self] in self?.renderFrame() }
        t.resume()
        timer = t
        let a = DispatchSource.makeTimerSource(queue: q)
        a.schedule(deadline: .now(), repeating: 0.02)
        a.setEventHandler { [weak self] in self?.renderAudio() }
        a.resume()
        audioTimer = a
    }

    private func renderFrame() {
        guard let pool else { return }
        var pbOut: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pbOut)
        guard let pb = pbOut else { return }
        lock.lock(); let h = held; lock.unlock()
        // BT.601 video-range YUV for red / green / blue backgrounds.
        let (y, u, v): (UInt8, UInt8, UInt8) = h.contains("A") ? (81, 90, 240) : h.contains("Start") ? (145, 54, 34) : (41, 240, 110)
        CVPixelBufferLockBaseAddress(pb, [])
        let yPlane = CVPixelBufferGetBaseAddressOfPlane(pb, 0)!.assumingMemoryBound(to: UInt8.self)
        let yStride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
        let uvPlane = CVPixelBufferGetBaseAddressOfPlane(pb, 1)!.assumingMemoryBound(to: UInt8.self)
        let uvStride = CVPixelBufferGetBytesPerRowOfPlane(pb, 1)
        let barX = (frame * 8) % width
        for row in 0..<height {
            let line = yPlane + row * yStride
            memset(line, Int32(y), width)
            // white moving bar (luma only) so motion is visible
            let x0 = barX, x1 = min(width, barX + 40)
            if x1 > x0 { memset(line + x0, 235, x1 - x0) }
        }
        for row in 0..<(height / 2) {
            let line = uvPlane + row * uvStride
            for col in stride(from: 0, to: width, by: 2) { line[col] = u; line[col + 1] = v }
        }
        CVPixelBufferUnlockBaseAddress(pb, [])
        frame += 1
        onVideo?(pb, CMTime(value: CMTimeValue(frame), timescale: CMTimeScale(fps)), 0)
    }

    private func renderAudio() {
        let rate = 48_000, frames = 960, ch = 2
        var out = [Float](repeating: 0, count: frames * ch)
        for f in 0..<frames {
            let s = Float(sin(phase) * 0.1)
            out[f * 2] = s; out[f * 2 + 1] = s
            phase += 2 * .pi * 440 / Double(rate)
        }
        onAudio?(out.withUnsafeBufferPointer { Data(buffer: $0) }, rate, ch)
    }

    func stop() {
        timer?.cancel(); audioTimer?.cancel()
    }
}
