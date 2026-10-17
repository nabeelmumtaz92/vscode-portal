// VSCode Portal screen helper for macOS. Started by screen.js inside VS Code.
//
// Captures a display with ScreenCaptureKit, encodes it as H.264 with VideoToolbox (hardware), and
// posts mouse and keyboard events with CoreGraphics. Also reports when a text field has keyboard
// focus, when the clipboard changes and where the pointer is.
//
// stdin:  one JSON command per line (see handle(_:)).
// stdout: frames of [u32 length][u8 kind][payload], length counting kind + payload.
//         kind 1 = video: [u8 flags (1 = keyframe)][u32 ms timestamp] then AVCC NAL units (u32 length + NAL);
//                  keyframes start with the SPS and PPS so a phone can start decoding from them.
//         kind 2 = event: UTF-8 JSON.
//
// macOS asks for Screen Recording and Accessibility permission for the app that started this
// helper, which is VS Code.

import AppKit
import ApplicationServices
import CoreMedia
import Foundation
import ScreenCaptureKit
import VideoToolbox

// MARK: - Output

let outQueue = DispatchQueue(label: "portal.out")
let stdoutHandle = FileHandle.standardOutput

func writeFrame(kind: UInt8, _ payload: Data) {
    var header = Data(count: 5)
    let length = UInt32(payload.count + 1).bigEndian
    withUnsafeBytes(of: length) { header.replaceSubrange(0..<4, with: $0) }
    header[4] = kind
    outQueue.async {
        stdoutHandle.write(header)
        stdoutHandle.write(payload)
    }
}

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    writeFrame(kind: 2, data)
}

func log(_ text: String) {
    FileHandle.standardError.write((text + "\n").data(using: .utf8)!)
}

// MARK: - Displays

struct DisplayInfo {
    let id: CGDirectDisplayID
    let bounds: CGRect // global points, top-left origin (the space CGEvent uses)
    let pixelWidth: Int
    let pixelHeight: Int
    let main: Bool
}

/// Main display first, then the rest left to right
func listDisplays() -> [DisplayInfo] {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    let main = CGMainDisplayID()
    return ids.map { id in
        let mode = CGDisplayCopyDisplayMode(id)
        return DisplayInfo(id: id, bounds: CGDisplayBounds(id),
                           pixelWidth: mode?.pixelWidth ?? Int(CGDisplayPixelsWide(id)),
                           pixelHeight: mode?.pixelHeight ?? Int(CGDisplayPixelsHigh(id)),
                           main: id == main)
    }.sorted { a, b in a.main != b.main ? a.main : a.bounds.minX < b.bounds.minX }
}

func displaysEvent() -> [String: Any] {
    ["event": "displays", "list": listDisplays().map {
        ["w": Int($0.bounds.width), "h": Int($0.bounds.height), "main": $0.main]
    }]
}

// MARK: - Encoder

final class Encoder {
    private var session: VTCompressionSession?
    private let width: Int32
    private let height: Int32
    private var forceKey = true
    private var startTime: CFTimeInterval = CACurrentMediaTime()
    private(set) var kbps: Int

    init?(width: Int, height: Int, fps: Int, kbps: Int) {
        self.width = Int32(width)
        self.height = Int32(height)
        self.kbps = kbps
        // Low-latency rate control: no frame reordering, steady frame sizes
        let spec = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true] as CFDictionary
        var created: VTCompressionSession?
        var status = VTCompressionSessionCreate(allocator: nil, width: self.width, height: self.height,
                                                codecType: kCMVideoCodecType_H264, encoderSpecification: spec,
                                                imageBufferAttributes: nil, compressedDataAllocator: nil,
                                                outputCallback: nil, refcon: nil, compressionSessionOut: &created)
        if status != noErr {
            status = VTCompressionSessionCreate(allocator: nil, width: self.width, height: self.height,
                                                codecType: kCMVideoCodecType_H264, encoderSpecification: nil,
                                                imageBufferAttributes: nil, compressedDataAllocator: nil,
                                                outputCallback: nil, refcon: nil, compressionSessionOut: &created)
        }
        guard status == noErr, let session = created else { return nil }
        self.session = session
        @discardableResult func set(_ key: CFString, _ value: CFTypeRef) -> OSStatus {
            VTSessionSetProperty(session, key: key, value: value)
        }
        set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue)
        set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse)
        if set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_ConstrainedHigh_AutoLevel) != noErr {
            set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_Main_AutoLevel)
        }
        set(kVTCompressionPropertyKey_ExpectedFrameRate, fps as CFNumber)
        // A keyframe at least every 2 s so a phone that drops frames recovers quickly
        set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, 2 as CFNumber)
        set(kVTCompressionPropertyKey_MaxKeyFrameInterval, (fps * 2) as CFNumber)
        setBitrate(kbps)
        VTCompressionSessionPrepareToEncodeFrames(session)
    }

    func setBitrate(_ kbps: Int) {
        guard let session else { return }
        self.kbps = kbps
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: (kbps * 1000) as CFNumber)
        // Hard cap over any 1 s window, so scrolling bursts don't swamp a phone connection
        let bytesPerSecond = kbps * 1000 / 8 * 3 / 2
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits,
                             value: [bytesPerSecond, 1] as CFArray)
    }

    func requestKeyframe() { forceKey = true }

    func encode(_ pixelBuffer: CVPixelBuffer) {
        guard let session else { return }
        let pts = CMTime(seconds: CACurrentMediaTime() - startTime, preferredTimescale: 1_000_000)
        let props = forceKey ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
        forceKey = false
        VTCompressionSessionEncodeFrame(session, imageBuffer: pixelBuffer, presentationTimeStamp: pts,
                                        duration: .invalid, frameProperties: props, infoFlagsOut: nil) { status, _, sample in
            guard status == noErr, let sample else { return }
            Encoder.send(sample)
        }
    }

    private static func send(_ sample: CMSampleBuffer) {
        guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
        var isKey = true
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]],
           let first = attachments.first, first[kCMSampleAttachmentKey_NotSync] as? Bool == true {
            isKey = false
        }
        var payload = Data()
        payload.append(isKey ? 1 : 0)
        var ms = UInt32(truncatingIfNeeded: Int(Date().timeIntervalSince1970 * 1000)).bigEndian
        withUnsafeBytes(of: &ms) { payload.append(contentsOf: $0) }
        if isKey, let format = CMSampleBufferGetFormatDescription(sample) {
            // SPS (index 0) and PPS (index 1), each as a length-prefixed NAL unit
            for index in 0..<2 {
                var pointer: UnsafePointer<UInt8>?
                var size = 0
                if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index,
                        parameterSetPointerOut: &pointer, parameterSetSizeOut: &size,
                        parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let pointer {
                    var length = UInt32(size).bigEndian
                    withUnsafeBytes(of: &length) { payload.append(contentsOf: $0) }
                    payload.append(pointer, count: size)
                }
            }
        }
        // The encoder's output is already AVCC (4-byte lengths)
        var total = 0
        var dataPointer: UnsafeMutablePointer<CChar>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &total,
                                          dataPointerOut: &dataPointer) == noErr, let dataPointer else { return }
        dataPointer.withMemoryRebound(to: UInt8.self, capacity: total) { payload.append($0, count: total) }
        writeFrame(kind: 1, payload)
    }

    func close() {
        guard let session else { return }
        VTCompressionSessionInvalidate(session)
        self.session = nil
    }
}

// MARK: - Capture

final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var encoder: Encoder?
    private let queue = DispatchQueue(label: "portal.capture")
    private var lastBuffer: CVPixelBuffer?
    private var generation = 0
    private(set) var display: DisplayInfo?

    func start(index: Int, fps: Int, kbps: Int, maxWidth: Int) {
        stop()
        generation += 1
        let myGeneration = generation
        let displays = listDisplays()
        guard !displays.isEmpty else { return emit(["event": "error", "message": "No display found."]) }
        let info = displays[min(max(0, index), displays.count - 1)]
        display = info
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let scDisplay = content.displays.first(where: { $0.displayID == info.id }) else {
                    return emit(["event": "error", "message": "That display isn't available."])
                }
                // Scale to at most maxWidth pixels wide; H.264 needs even sizes
                let scale = min(1.0, Double(maxWidth) / Double(info.pixelWidth))
                let width = max(2, Int(Double(info.pixelWidth) * scale) / 2 * 2)
                let height = max(2, Int(Double(info.pixelHeight) * scale) / 2 * 2)

                let config = SCStreamConfiguration()
                config.width = width
                config.height = height
                config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
                config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
                config.showsCursor = true
                config.queueDepth = 4
                let filter = SCContentFilter(display: scDisplay, excludingWindows: [])
                let stream = SCStream(filter: filter, configuration: config, delegate: self)
                try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)

                guard let encoder = Encoder(width: width, height: height, fps: fps, kbps: kbps) else {
                    return emit(["event": "error", "message": "Couldn't start the video encoder."])
                }
                try await stream.startCapture()
                queue.sync {
                    guard myGeneration == self.generation else { return }
                    self.stream = stream
                    self.encoder = encoder
                }
                guard myGeneration == generation else {
                    try? await stream.stopCapture()
                    encoder.close()
                    return
                }
                emit(["event": "capture", "state": "started", "w": width, "h": height,
                      "screen": index, "fps": fps, "kbps": kbps])
            } catch {
                let denied = !CGPreflightScreenCaptureAccess()
                emit(["event": "error", "permission": denied ? "screen" : NSNull(),
                      "message": denied
                        ? "macOS hasn't allowed VS Code to record the screen. On the Mac: System Settings → Privacy & Security → Screen Recording → turn on Visual Studio Code, then quit and reopen VS Code."
                        : "Screen capture failed: \(error.localizedDescription)"])
            }
        }
    }

    func stop() {
        generation += 1
        let stream = self.stream
        queue.sync {
            self.stream = nil
            self.encoder?.close()
            self.encoder = nil
            self.lastBuffer = nil
        }
        if let stream { Task { try? await stream.stopCapture() } }
        display = nil
    }

    /// A phone joined or recovered: send a keyframe now, even if the screen isn't changing
    func requestKeyframe() {
        queue.async {
            self.encoder?.requestKeyframe()
            if let buffer = self.lastBuffer { self.encoder?.encode(buffer) }
        }
    }

    func setBitrate(_ kbps: Int) {
        queue.async { self.encoder?.setBitrate(kbps) }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sample.isValid, let encoder,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let statusRaw = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: statusRaw) == .complete,
              let buffer = CMSampleBufferGetImageBuffer(sample) else { return }
        lastBuffer = buffer
        encoder.encode(buffer)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(["event": "error", "message": "Screen capture stopped: \(error.localizedDescription)"])
    }
}

// MARK: - Input

let keySource = CGEventSource(stateID: .privateState)
var buttonsDown: [String: Bool] = ["left": false, "right": false, "middle": false]

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
    "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39,
    "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50, " ": 49,
    "Return": 36, "Tab": 48, "Space": 49, "Backspace": 51, "Escape": 53, "Delete": 117,
    "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121, "Left": 123, "Right": 124, "Down": 125, "Up": 126,
    "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97, "F7": 98, "F8": 100, "F9": 101, "F10": 109,
    "F11": 103, "F12": 111,
]
let shifted: [Character: String] = [
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
    "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
]
let modifierFlags: [String: CGEventFlags] = [
    "shift": .maskShift, "control": .maskControl, "alt": .maskAlternate, "command": .maskCommand,
]

/// The part of the desktop the video shows (global points)
func currentRegion() -> CGRect {
    capture.display?.bounds ?? listDisplays().first?.bounds ?? .zero
}

func pointerLocation() -> CGPoint {
    CGEvent(source: nil)?.location ?? .zero
}

func point(for cmd: [String: Any]) -> CGPoint {
    guard let x = cmd["x"] as? Double, let y = cmd["y"] as? Double else { return pointerLocation() }
    let r = currentRegion()
    return CGPoint(x: r.minX + x * r.width, y: r.minY + y * r.height)
}

func postMouse(_ type: CGEventType, at point: CGPoint, button: String, clicks: Int = 0) {
    let number: CGMouseButton = button == "right" ? .right : button == "middle" ? .center : .left
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: number) else { return }
    if clicks > 0 { event.setIntegerValueField(.mouseEventClickState, value: Int64(clicks)) }
    event.post(tap: .cghidEventTap)
}

func downType(_ button: String) -> CGEventType { button == "right" ? .rightMouseDown : button == "middle" ? .otherMouseDown : .leftMouseDown }
func upType(_ button: String) -> CGEventType { button == "right" ? .rightMouseUp : button == "middle" ? .otherMouseUp : .leftMouseUp }

func postMove(to point: CGPoint) {
    if buttonsDown["left"] == true { postMouse(.leftMouseDragged, at: point, button: "left") }
    else if buttonsDown["right"] == true { postMouse(.rightMouseDragged, at: point, button: "right") }
    else if buttonsDown["middle"] == true { postMouse(.otherMouseDragged, at: point, button: "middle") }
    else { postMouse(.mouseMoved, at: point, button: "left") }
}

/// After a key with modifiers, tell macOS they're released, so Command/Shift never stay "held"
func releaseModifiers() {
    guard let event = CGEvent(source: keySource) else { return }
    event.type = .flagsChanged
    event.flags = []
    event.post(tap: .cghidEventTap)
}

func postKey(_ code: CGKeyCode, flags: CGEventFlags) {
    guard let down = CGEvent(keyboardEventSource: keySource, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: keySource, virtualKey: code, keyDown: false) else { return }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    if !flags.isEmpty { releaseModifiers() }
}

/// Characters with no key on a US layout (emoji, accents) are typed as Unicode
func postUnicode(_ text: String) {
    let units = Array(text.utf16)
    guard let down = CGEvent(keyboardEventSource: keySource, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: keySource, virtualKey: 0, keyDown: false) else { return }
    down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
    up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

func lookup(_ ch: Character) -> (CGKeyCode, CGEventFlags)? {
    if ch == "\n" || ch == "\r" { return (36, []) }
    if ch == "\t" { return (48, []) }
    let s = String(ch)
    if let code = keyCodes[s] { return (code, []) }
    let lower = s.lowercased()
    if lower != s, let code = keyCodes[lower] { return (code, .maskShift) }
    if let base = shifted[ch], let code = keyCodes[base] { return (code, .maskShift) }
    return nil
}

func handleInput(_ cmd: [String: Any]) {
    let button = (cmd["button"] as? String) ?? "left"
    let count = (cmd["count"] as? Int) ?? 1
    switch cmd["type"] as? String {
    case "move":
        postMove(to: point(for: cmd))
    case "moveBy":
        let r = currentRegion()
        let from = pointerLocation()
        let dx = (cmd["dx"] as? Double) ?? 0, dy = (cmd["dy"] as? Double) ?? 0
        postMove(to: CGPoint(x: min(max(from.x + dx * r.width, r.minX), r.maxX - 1),
                             y: min(max(from.y + dy * r.height, r.minY), r.maxY - 1)))
    case "down":
        buttonsDown[button] = true
        postMouse(downType(button), at: point(for: cmd), button: button, clicks: count)
    case "up":
        buttonsDown[button] = false
        postMouse(upType(button), at: point(for: cmd), button: button, clicks: count)
    case "click":
        let p = point(for: cmd)
        if cmd["x"] != nil { postMouse(.mouseMoved, at: p, button: "left") }
        postMouse(downType(button), at: p, button: button, clicks: count)
        postMouse(upType(button), at: p, button: button, clicks: count)
    case "scroll":
        let dx = Int32((cmd["dx"] as? Double) ?? 0), dy = Int32((cmd["dy"] as? Double) ?? 0)
        CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)?
            .post(tap: .cghidEventTap)
    case "key":
        guard let key = cmd["key"] as? String else { return }
        var flags: CGEventFlags = []
        for m in (cmd["modifiers"] as? [String]) ?? [] { if let f = modifierFlags[m] { flags.insert(f) } }
        if key.count > 1, let code = keyCodes[key] { return postKey(code, flags: flags) }
        if let ch = key.first, let (code, extra) = lookup(ch) { postKey(code, flags: flags.union(extra)) }
        else { postUnicode(key) }
    case "text":
        guard let text = cmd["text"] as? String else { return }
        var pending = ""
        for ch in text {
            if let (code, flags) = lookup(ch) {
                if !pending.isEmpty { postUnicode(pending); pending = "" }
                postKey(code, flags: flags)
            } else {
                pending.append(ch)
            }
        }
        if !pending.isEmpty { postUnicode(pending) }
    case "clipboard":
        guard let text = cmd["text"] as? String else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        lastChangeCount = NSPasteboard.general.changeCount // not a copy on the Mac; don't echo it back
    default:
        break
    }
}

// MARK: - Focus, clipboard and pointer

let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
var enabledApps = Set<pid_t>()
var lastEditable: Bool?
var lastChangeCount = NSPasteboard.general.changeCount
var lastCursor = CGPoint(x: -1, y: -1)
var watching = false

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func focusedIsEditable() -> Bool {
    guard AXIsProcessTrusted(), let app = NSWorkspace.shared.frontmostApplication else { return false }
    let element = AXUIElementCreateApplication(app.processIdentifier)
    if !enabledApps.contains(app.processIdentifier) {
        // Electron and Chromium apps only build their accessibility tree when asked
        AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        enabledApps.insert(app.processIdentifier)
    }
    guard let focused = attribute(element, kAXFocusedUIElementAttribute) else { return false }
    let el = focused as! AXUIElement
    if let role = attribute(el, kAXRoleAttribute) as? String, textRoles.contains(role) { return true }
    guard attribute(el, kAXSelectedTextRangeAttribute) != nil else { return false }
    var settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
}

func startWatching() {
    guard !watching else { return }
    watching = true
    Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
        guard watching else { return }
        let editable = focusedIsEditable()
        if editable != lastEditable {
            lastEditable = editable
            emit(["event": "focus", "editable": editable])
        }
        let pasteboard = NSPasteboard.general
        if pasteboard.changeCount != lastChangeCount {
            lastChangeCount = pasteboard.changeCount
            if let text = pasteboard.string(forType: .string), text.count <= 1_000_000 {
                emit(["event": "clipboard", "text": text])
            }
        }
    }
    Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { _ in
        guard watching else { return }
        let p = pointerLocation()
        guard p != lastCursor else { return }
        lastCursor = p
        let r = currentRegion()
        guard r.width > 0, r.height > 0 else { return }
        let x = (p.x - r.minX) / r.width, y = (p.y - r.minY) / r.height
        emit(["event": "cursor", "x": (x * 10000).rounded() / 10000, "y": (y * 10000).rounded() / 10000,
              "visible": x >= 0 && x <= 1 && y >= 0 && y <= 1])
    }
}

// MARK: - Commands

let capture = Capture()

func permissions(prompt: Bool) -> [String: Any] {
    if prompt {
        if !CGPreflightScreenCaptureAccess() { CGRequestScreenCaptureAccess() }
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary)
    }
    return ["event": "permissions", "screen": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()]
}

func handle(_ cmd: [String: Any]) {
    if cmd["type"] != nil { return handleInput(cmd) }
    switch cmd["cmd"] as? String {
    case "capture":
        startWatching()
        capture.start(index: (cmd["screen"] as? Int) ?? 0, fps: min(60, max(5, (cmd["fps"] as? Int) ?? 30)),
                      kbps: min(20000, max(300, (cmd["kbps"] as? Int) ?? 4000)),
                      maxWidth: min(3840, max(320, (cmd["maxWidth"] as? Int) ?? 1920)))
    case "stop":
        watching = false
        capture.stop()
    case "keyframe":
        capture.requestKeyframe()
    case "bitrate":
        capture.setBitrate(min(20000, max(300, (cmd["kbps"] as? Int) ?? 4000)))
    case "displays":
        emit(displaysEvent())
    case "permissions":
        emit(permissions(prompt: cmd["prompt"] as? Bool == true))
    default:
        break
    }
}

setvbuf(stdout, nil, _IONBF, 0)
var ready = permissions(prompt: false)
ready["event"] = "ready"
emit(ready)
emit(displaysEvent())

// Commands arrive on a background thread and run on the main thread, with the timers
Thread {
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let cmd = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
        DispatchQueue.main.async { handle(cmd) }
    }
    exit(0) // VS Code closed the pipe
}.start()

NSApplication.shared.setActivationPolicy(.prohibited)
RunLoop.main.run()
