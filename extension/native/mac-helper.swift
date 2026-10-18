// VSCode Portal's Mac helper for the Mac agent (from Portal's macos-helper.swift). One long-running process
// (started by extension/agent/mac.js)
// that does window, app, accessibility, typing, media and volume work in-process, so actions take
// milliseconds instead of spawning osascript each time.
//
// Protocol: JSON lines. Request {"id": 1, "cmd": "windows", ...args}; reply {"id": 1, "ok": true, "result": …}
// or {"id": 1, "ok": false, "error": "…"}. Coordinates are global points, top-left origin (CoreGraphics).
// Needs Accessibility permission (inherited from Portal's server) for the AX and typing commands.

import AppKit
import ApplicationServices
import CoreGraphics
import QuartzCore

setvbuf(stdout, nil, _IOLBF, 0)
// An app object (without a Dock icon) so the helper can show click ripples on screen
NSApplication.shared.setActivationPolicy(.accessory)

struct HelperError: Error { let message: String; init(_ m: String) { message = m } }

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
}

// MARK: - Apps

func normalized(_ s: String) -> String {
    s.lowercased().replacingOccurrences(of: ".app", with: "").trimmingCharacters(in: .whitespaces)
}

func regularApps() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !$0.isTerminated }
}

/// Exact name, then bundle id, then a name that contains the query ("chrome" → Google Chrome)
func findRunningApp(_ name: String) -> NSRunningApplication? {
    let q = normalized(name)
    let apps = regularApps()
    return apps.first { normalized($0.localizedName ?? "") == q }
        ?? apps.first { ($0.bundleIdentifier ?? "").lowercased() == q }
        ?? apps.first { normalized($0.localizedName ?? "").contains(q) }
        ?? apps.first { q.contains(normalized($0.localizedName ?? "~")) }
}

func appInfo(_ app: NSRunningApplication) -> [String: Any] {
    ["name": app.localizedName ?? "", "pid": Int(app.processIdentifier), "bundle": app.bundleIdentifier ?? "",
     "active": app.isActive, "hidden": app.isHidden]
}

let appFolders = ["/Applications", "/System/Applications", "/System/Applications/Utilities",
                  "/Applications/Utilities", NSHomeDirectory() + "/Applications", "/System/Library/CoreServices"]

func findAppURL(_ name: String) -> URL? {
    let q = normalized(name)
    if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) { return url }
    let fm = FileManager.default
    var partial: URL?
    for folder in appFolders {
        guard let items = try? fm.contentsOfDirectory(atPath: folder) else { continue }
        for item in items where item.hasSuffix(".app") {
            let n = normalized(item)
            if n == q { return URL(fileURLWithPath: folder).appendingPathComponent(item) }
            if partial == nil, n.contains(q) { partial = URL(fileURLWithPath: folder).appendingPathComponent(item) }
        }
    }
    return partial
}

func waitUntil(_ seconds: Double, _ condition: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
        if condition() { return true }
        RunLoop.current.run(until: Date().addingTimeInterval(0.03))
    }
    return condition()
}

func launch(_ name: String) throws -> [String: Any] {
    if let running = findRunningApp(name) {
        running.unhide()
        running.activate()
        return ["name": running.localizedName ?? name, "alreadyRunning": true]
    }
    guard let url = findAppURL(name) else { throw HelperError("No app called \(name) was found.") }
    let config = NSWorkspace.OpenConfiguration()
    config.activates = true
    var launched: NSRunningApplication?
    var failure: Error?
    let done = DispatchSemaphore(value: 0)
    NSWorkspace.shared.openApplication(at: url, configuration: config) { app, error in
        launched = app; failure = error; done.signal()
    }
    _ = waitUntil(10) { done.wait(timeout: .now()) == .success }
    if let failure { throw HelperError(failure.localizedDescription) }
    return ["name": launched?.localizedName ?? url.deletingPathExtension().lastPathComponent, "alreadyRunning": false]
}

// MARK: - Windows (CoreGraphics list: instant, no AppleScript)

func windowList() -> [[String: Any]] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let info = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return [] }
    let names = Dictionary(regularApps().map { (Int($0.processIdentifier), $0.localizedName ?? "") }, uniquingKeysWith: { a, _ in a })
    var result: [[String: Any]] = []
    for (order, w) in info.enumerated() {
        guard (w[kCGWindowLayer as String] as? Int) == 0,
              let pid = w[kCGWindowOwnerPID as String] as? Int, let app = names[pid],
              let b = w[kCGWindowBounds as String] as? [String: CGFloat],
              let width = b["Width"], let height = b["Height"], width >= 50, height >= 50,
              (w[kCGWindowAlpha as String] as? Double ?? 1) > 0 else { continue }
        result.append([
            "id": w[kCGWindowNumber as String] as? Int ?? 0, "pid": pid, "app": app,
            "title": w[kCGWindowName as String] as? String ?? "",
            "x": b["X"] ?? 0, "y": b["Y"] ?? 0, "w": width, "h": height, "order": order,
        ])
    }
    return result
}

func displays() -> [[String: Any]] {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    return ids.map { id in
        let r = CGDisplayBounds(id)
        return ["x": r.origin.x, "y": r.origin.y, "w": r.width, "h": r.height, "main": CGDisplayIsMain(id) != 0]
    }
}

// MARK: - Accessibility

func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}

func str(_ e: AXUIElement, _ name: String) -> String {
    if let s = attr(e, name) as? String { return s }
    if let n = attr(e, name) as? NSNumber { return n.stringValue }
    return ""
}

func frame(_ e: AXUIElement) -> [CGFloat]? {
    guard let p = attr(e, kAXPositionAttribute), let s = attr(e, kAXSizeAttribute) else { return nil }
    var point = CGPoint.zero, size = CGSize.zero
    AXValueGetValue(p as! AXValue, .cgPoint, &point)
    AXValueGetValue(s as! AXValue, .cgSize, &size)
    return [point.x, point.y, size.width, size.height]
}

var manualAccessibility = Set<pid_t>()
func appElement(_ app: NSRunningApplication) -> AXUIElement {
    let element = AXUIElementCreateApplication(app.processIdentifier)
    if !manualAccessibility.contains(app.processIdentifier) {
        // Electron/Chromium apps (VS Code, Slack, Chrome) only build their tree when asked
        AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(element, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        manualAccessibility.insert(app.processIdentifier)
    }
    return element
}

func requireTrusted() throws {
    if !AXIsProcessTrusted() {
        throw HelperError("macOS hasn't given Portal Accessibility permission (System Settings → Privacy & Security → Accessibility).")
    }
}

func axWindows(_ app: NSRunningApplication) -> [AXUIElement] {
    (attr(appElement(app), kAXWindowsAttribute) as? [AXUIElement]) ?? []
}

/// A window of the app whose title contains `title` (any window if empty), preferring the focused one
func findWindow(app: NSRunningApplication, title: String) throws -> AXUIElement {
    try requireTrusted()
    let windows = axWindows(app)
    guard !windows.isEmpty else { throw HelperError("\(app.localizedName ?? "That app") has no open windows.") }
    let q = title.lowercased()
    if !q.isEmpty {
        if let w = windows.first(where: { str($0, kAXTitleAttribute).lowercased().contains(q) }) { return w }
        let titles = windows.map { str($0, kAXTitleAttribute) }.filter { !$0.isEmpty }
        throw HelperError("No \(app.localizedName ?? "") window titled “\(title)”. Open windows: \(titles.joined(separator: " | "))")
    }
    if let focused = attr(appElement(app), kAXFocusedWindowAttribute) { return focused as! AXUIElement }
    return windows[0]
}

func windowAction(appName: String, title: String, action: String) throws -> [String: Any] {
    guard let app = findRunningApp(appName) else { throw HelperError("\(appName) isn't running.") }
    let window = try findWindow(app: app, title: title)
    let name = str(window, kAXTitleAttribute)
    switch action {
    case "close":
        guard let button = attr(window, kAXCloseButtonAttribute) else { throw HelperError("That window can't be closed.") }
        AXUIElementPerformAction(button as! AXUIElement, kAXPressAction as CFString)
    case "minimize":
        AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
    case "unminimize", "focus":
        AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
        app.unhide()
        app.activate()
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
    case "fullscreen":
        let on = (attr(window, "AXFullScreen") as? Bool) ?? false
        AXUIElementSetAttributeValue(window, "AXFullScreen" as CFString, on ? kCFBooleanFalse : kCFBooleanTrue)
    case "zoom":
        guard let button = attr(window, kAXZoomButtonAttribute) else { throw HelperError("That window can't be zoomed.") }
        AXUIElementPerformAction(button as! AXUIElement, kAXPressAction as CFString)
    default:
        throw HelperError("Unknown window action \(action).")
    }
    return ["app": app.localizedName ?? appName, "title": name]
}

// Elements found by ax_find, so ax_press/ax_set_value can refer to them by id
var elementCache: [Int: AXUIElement] = [:]
var nextElementID = 1

let roleAliases = ["button": "AXButton", "checkbox": "AXCheckBox", "link": "AXLink", "menu item": "AXMenuItem",
                   "menuitem": "AXMenuItem", "tab": "AXRadioButton", "text field": "AXTextField", "textfield": "AXTextField",
                   "text area": "AXTextArea", "field": "AXTextField", "radio": "AXRadioButton", "popup": "AXPopUpButton",
                   "menu": "AXMenuBarItem", "image": "AXImage", "row": "AXRow", "cell": "AXCell", "slider": "AXSlider"]

func elementLabel(_ e: AXUIElement) -> String {
    for name in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, "AXPlaceholderValue", kAXHelpAttribute, kAXIdentifierAttribute] {
        let s = str(e, name).trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.isEmpty { return String(s.prefix(120)) }
    }
    if let title = attr(e, kAXTitleUIElementAttribute) { return str(title as! AXUIElement, kAXValueAttribute) }
    return ""
}

/// Breadth-first search of an app's UI (windows, then the menu bar) for elements matching text and role
func axFind(appName: String, text: String, role: String, limit: Int, includeMenus: Bool) throws -> [[String: Any]] {
    try requireTrusted()
    guard let app = findRunningApp(appName) ?? (appName.isEmpty ? NSWorkspace.shared.frontmostApplication : nil) else {
        throw HelperError("\(appName) isn't running.")
    }
    let root = appElement(app)
    let q = text.lowercased()
    let wantedRole = role.isEmpty ? "" : (roleAliases[role.lowercased()] ?? role)
    var queue: [(AXUIElement, Int)] = axWindows(app).map { ($0, 0) }
    if includeMenus, let bar = attr(root, kAXMenuBarAttribute) { queue.append((bar as! AXUIElement, 0)) }
    var found: [[String: Any]] = []
    var visited = 0
    let deadline = Date().addingTimeInterval(2.0)
    while !queue.isEmpty, found.count < limit, visited < 6000, Date() < deadline {
        let (element, depth) = queue.removeFirst()
        visited += 1
        let elementRole = str(element, kAXRoleAttribute)
        let label = elementLabel(element)
        let roleMatches = wantedRole.isEmpty || elementRole == wantedRole
        let textMatches = q.isEmpty || label.lowercased().contains(q)
        if roleMatches, textMatches, !(q.isEmpty && wantedRole.isEmpty), elementRole != "AXWindow" {
            let id = nextElementID
            nextElementID += 1
            elementCache[id] = element
            var item: [String: Any] = ["id": id, "role": elementRole, "name": label]
            if let f = frame(element) { item["frame"] = f }
            if str(element, kAXEnabledAttribute) == "0" { item["disabled"] = true }
            found.append(item)
        }
        if depth < 40, let children = attr(element, kAXChildrenAttribute) as? [AXUIElement] {
            queue.append(contentsOf: children.map { ($0, depth + 1) })
        }
    }
    if elementCache.count > 5000 { elementCache.removeAll() }
    // Exact matches first, then shorter labels (more specific)
    return found.sorted { a, b in
        let la = (a["name"] as? String ?? "").lowercased(), lb = (b["name"] as? String ?? "").lowercased()
        if (la == q) != (lb == q) { return la == q }
        return la.count < lb.count
    }
}

func axPress(_ id: Int) throws -> [String: Any] {
    guard let element = elementCache[id] else { throw HelperError("That element is gone; search for it again.") }
    var names: CFArray?
    AXUIElementCopyActionNames(element, &names)
    let actions = (names as? [String]) ?? []
    for action in [kAXPressAction, kAXConfirmAction, kAXPickAction, kAXShowMenuAction] where actions.contains(action) {
        if AXUIElementPerformAction(element, action as CFString) == .success {
            return ["pressed": true, "action": action, "name": elementLabel(element)]
        }
    }
    // Some elements only respond to a real click: click the middle of it
    guard let f = frame(element) else { throw HelperError("That element can't be pressed.") }
    click(at: CGPoint(x: f[0] + f[2] / 2, y: f[1] + f[3] / 2))
    return ["pressed": true, "action": "click", "name": elementLabel(element)]
}

func axSetValue(_ id: Int, _ value: String) throws -> [String: Any] {
    guard let element = elementCache[id] else { throw HelperError("That element is gone; search for it again.") }
    AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    let result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
    guard result == .success else { throw HelperError("That element doesn't accept text (\(result.rawValue)).") }
    return ["set": true]
}

// MARK: - Click ripple (visible on the phone, since Portal streams the real screen)

var rippleWindows: [NSWindow] = []

func ripple(at point: CGPoint) {
    let size: CGFloat = 70
    // CoreGraphics coordinates are top-left based on the main display; windows use bottom-left
    let mainHeight = NSScreen.screens.first?.frame.height ?? 0
    let rect = NSRect(x: point.x - size / 2, y: mainHeight - point.y - size / 2, width: size, height: size)
    let window = NSWindow(contentRect: rect, styleMask: .borderless, backing: .buffered, defer: false)
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.ignoresMouseEvents = true  // clicks go straight through to what's underneath
    window.level = .screenSaver
    window.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    let view = NSView(frame: NSRect(origin: .zero, size: rect.size))
    view.wantsLayer = true
    let circle = CAShapeLayer()
    circle.frame = view.bounds
    circle.path = CGPath(ellipseIn: view.bounds.insetBy(dx: 5, dy: 5), transform: nil)
    circle.fillColor = NSColor.systemBlue.withAlphaComponent(0.28).cgColor
    circle.strokeColor = NSColor.systemBlue.cgColor
    circle.lineWidth = 3
    view.layer?.addSublayer(circle)
    window.contentView = view
    window.orderFrontRegardless()

    let grow = CABasicAnimation(keyPath: "transform.scale")
    grow.fromValue = 0.25
    grow.toValue = 1.0
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 1.0
    fade.toValue = 0.0
    let group = CAAnimationGroup()
    group.animations = [grow, fade]
    group.duration = 0.7
    group.timingFunction = CAMediaTimingFunction(name: .easeOut)
    group.fillMode = .forwards
    group.isRemovedOnCompletion = false
    circle.add(group, forKey: "ripple")

    rippleWindows.append(window)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) {
        window.orderOut(nil)
        rippleWindows.removeAll { $0 === window }
    }
}

// MARK: - Input

func click(at point: CGPoint) {
    let source = CGEventSource(stateID: .hidSystemState)
    for type in [CGEventType.leftMouseDown, .leftMouseUp] {
        CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    }
}

/// Types any text (emoji and accents included) as keyboard events, a few characters per event
func typeText(_ text: String) {
    let source = CGEventSource(stateID: .hidSystemState)
    let units = Array(text.utf16)
    var i = 0
    while i < units.count {
        var end = min(i + 16, units.count)
        // Don't split a surrogate pair (emoji) across events
        if end < units.count, UTF16.isLeadSurrogate(units[end - 1]) { end -= 1 }
        var chunk = Array(units[i..<end])
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
            event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
            event?.post(tap: .cghidEventTap)
        }
        i = end
        usleep(4000)
    }
}

// Media and brightness keys are "system defined" events (NX_KEYTYPE_* codes)
let mediaKeys: [String: Int32] = ["volume_up": 0, "volume_down": 1, "brightness_up": 2, "brightness_down": 3,
                                  "mute": 7, "play_pause": 16, "next": 17, "previous": 18, "fast_forward": 19, "rewind": 20,
                                  "illumination_up": 21, "illumination_down": 22]

func pressMediaKey(_ name: String) throws {
    guard let code = mediaKeys[name] else { throw HelperError("Unknown media key \(name).") }
    for down in [true, false] {
        let flags = NSEvent.ModifierFlags(rawValue: down ? 0xa00 : 0xb00)
        let data1 = Int((code << 16) | ((down ? 0xa : 0xb) << 8))
        NSEvent.otherEvent(with: .systemDefined, location: .zero, modifierFlags: flags, timestamp: 0,
                           windowNumber: 0, context: nil, subtype: 8, data1: data1, data2: -1)?
            .cgEvent?.post(tap: .cghidEventTap)
    }
}

// MARK: - Volume (in-process AppleScript: no osascript spawn)

func runAppleScript(_ source: String) throws -> String {
    var error: NSDictionary?
    let result = NSAppleScript(source: source)?.executeAndReturnError(&error)
    if let error { throw HelperError(error[NSAppleScript.errorMessage] as? String ?? "AppleScript failed") }
    return result?.stringValue ?? ""
}

func volume(_ args: [String: Any]) throws -> [String: Any] {
    if let level = args["level"] as? Double {
        _ = try runAppleScript("set volume output volume \(Int(max(0, min(100, level))))")
    }
    if let delta = args["delta"] as? Double {
        let current = Double(try runAppleScript("output volume of (get volume settings)")) ?? 50
        _ = try runAppleScript("set volume output volume \(Int(max(0, min(100, current + delta))))")
    }
    if let muted = args["muted"] as? Bool {
        _ = try runAppleScript("set volume output muted \(muted)")
    }
    let level = Int(try runAppleScript("output volume of (get volume settings)")) ?? -1
    let muted = try runAppleScript("output muted of (get volume settings)") == "true"
    return ["level": level, "muted": muted]
}

// MARK: - Clipboard (save/restore keeps whatever the user had copied)

var savedClipboard: [[NSPasteboard.PasteboardType: Data]] = []

func clipboard(_ args: [String: Any]) -> [String: Any] {
    let pb = NSPasteboard.general
    if args["save"] as? Bool == true {
        savedClipboard = (pb.pasteboardItems ?? []).map { item in
            Dictionary(item.types.compactMap { t in item.data(forType: t).map { (t, $0) } }, uniquingKeysWith: { a, _ in a })
        }
    }
    if let text = args["set"] as? String {
        pb.clearContents()
        pb.setString(text, forType: .string)
    }
    if args["restore"] as? Bool == true {
        pb.clearContents()
        let items = savedClipboard.map { saved -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in saved { item.setData(data, forType: type) }
            return item
        }
        if !items.isEmpty { pb.writeObjects(items) }
    }
    return ["text": pb.string(forType: .string) ?? ""]
}

// MARK: - Mouse and keyboard in global points (for the agent's computer tool)

let agentKeySource = CGEventSource(stateID: .privateState)
let agentKeyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
    "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39,
    "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50, " ": 49,
    "return": 36, "tab": 48, "space": 49, "backspace": 51, "escape": 53, "delete": 117,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109,
    "f11": 103, "f12": 111,
]
let agentModifiers: [String: CGEventFlags] = [
    "shift": .maskShift, "control": .maskControl, "alt": .maskAlternate, "command": .maskCommand,
]
var agentButtonsDown = Set<String>()

func mouseEvent(_ type: CGEventType, _ p: CGPoint, _ button: String, clicks: Int = 0, flags: CGEventFlags = []) {
    let number: CGMouseButton = button == "right" ? .right : button == "middle" ? .center : .left
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: number) else { return }
    if clicks > 0 { event.setIntegerValueField(.mouseEventClickState, value: Int64(clicks)) }
    if !flags.isEmpty { event.flags = flags }
    event.post(tap: .cghidEventTap)
}

func mouse(_ r: [String: Any]) throws -> [String: Any] {
    try requireTrusted()
    let current = CGEvent(source: nil)?.location ?? .zero
    let p = (r["x"] as? Double).flatMap { x in (r["y"] as? Double).map { CGPoint(x: x, y: $0) } } ?? current
    let button = r["button"] as? String ?? "left"
    var flags: CGEventFlags = []
    for m in r["modifiers"] as? [String] ?? [] { if let f = agentModifiers[m] { flags.insert(f) } }
    let down: CGEventType = button == "right" ? .rightMouseDown : button == "middle" ? .otherMouseDown : .leftMouseDown
    let up: CGEventType = button == "right" ? .rightMouseUp : button == "middle" ? .otherMouseUp : .leftMouseUp
    switch r["action"] as? String ?? "" {
    case "move":
        mouseEvent(agentButtonsDown.contains("left") ? .leftMouseDragged : .mouseMoved, p, "left")
    case "down":
        agentButtonsDown.insert(button)
        mouseEvent(down, p, button, clicks: 1, flags: flags)
    case "up":
        agentButtonsDown.remove(button)
        mouseEvent(up, p, button, clicks: 1, flags: flags)
    case "click":
        let count = max(1, min(3, r["count"] as? Int ?? 1))
        mouseEvent(.mouseMoved, p, "left")
        for n in 1...count {
            mouseEvent(down, p, button, clicks: n, flags: flags)
            mouseEvent(up, p, button, clicks: n, flags: flags)
        }
    case "drag":
        let to = CGPoint(x: r["x2"] as? Double ?? p.x, y: r["y2"] as? Double ?? p.y)
        mouseEvent(.mouseMoved, p, "left")
        mouseEvent(.leftMouseDown, p, "left", clicks: 1)
        let steps = 12
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            mouseEvent(.leftMouseDragged, CGPoint(x: p.x + (to.x - p.x) * t, y: p.y + (to.y - p.y) * t), "left")
            usleep(12_000)
        }
        mouseEvent(.leftMouseUp, to, "left", clicks: 1)
    case "scroll":
        mouseEvent(.mouseMoved, p, "left")
        let dx = Int32(r["dx"] as? Double ?? 0), dy = Int32(r["dy"] as? Double ?? 0)
        CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)?.post(tap: .cghidEventTap)
    case "glide":
        // Show where the next click lands: move the real pointer there smoothly (ease out)
        let steps = 14
        for i in 1...steps {
            let t = Double(i) / Double(steps), e = 1 - (1 - t) * (1 - t)
            mouseEvent(.mouseMoved, CGPoint(x: current.x + (p.x - current.x) * e, y: current.y + (p.y - current.y) * e), "left")
            usleep(15_000)
        }
    default:
        throw HelperError("Unknown mouse action.")
    }
    return ["x": p.x, "y": p.y]
}

/// A key or combo: key is a name from agentKeyCodes or one character; modifiers command/shift/control/alt
func pressKey(_ r: [String: Any]) throws -> [String: Any] {
    try requireTrusted()
    let key = (r["key"] as? String ?? "")
    var flags: CGEventFlags = []
    for m in r["modifiers"] as? [String] ?? [] { if let f = agentModifiers[m] { flags.insert(f) } }
    let lower = key.count > 1 ? key.lowercased() : key
    guard let code = agentKeyCodes[lower] ?? agentKeyCodes[key.lowercased()] else {
        if key.count == 1 && flags.isEmpty { typeText(key); return ["typed": key] }
        throw HelperError("Unknown key \(key).")
    }
    if key.count == 1, key != key.lowercased() { flags.insert(.maskShift) }
    let repeats = max(1, min(50, r["repeat"] as? Int ?? 1))
    for _ in 0..<repeats {
        guard let down = CGEvent(keyboardEventSource: agentKeySource, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: agentKeySource, virtualKey: code, keyDown: false) else { break }
        down.flags = flags; up.flags = flags
        down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
    }
    if !flags.isEmpty, let reset = CGEvent(source: agentKeySource) {
        reset.type = .flagsChanged; reset.flags = []; reset.post(tap: .cghidEventTap)
    }
    return ["pressed": key]
}

// MARK: - Dispatch


func handle(_ request: [String: Any]) throws -> Any {
    let cmd = request["cmd"] as? String ?? ""
    let s = { (key: String) in request[key] as? String ?? "" }
    switch cmd {
    case "ping":
        return ["trusted": AXIsProcessTrusted(), "pid": Int(getpid())]
    case "mouse":
        return try mouse(request)
    case "key":
        return try pressKey(request)
    case "cursor":
        let p = CGEvent(source: nil)?.location ?? .zero
        return ["x": p.x, "y": p.y]
    case "apps":
        return regularApps().map(appInfo)
    case "frontmost":
        return NSWorkspace.shared.frontmostApplication.map(appInfo) ?? [:]
    case "windows":
        return windowList()
    case "displays":
        return displays()
    case "launch":
        return try launch(s("app"))
    case "activate":
        guard let app = findRunningApp(s("app")) else { return try launch(s("app")) }
        app.unhide()
        app.activate()
        return appInfo(app)
    case "hide":
        guard let app = findRunningApp(s("app")) else { throw HelperError("\(s("app")) isn't running.") }
        app.hide()
        return appInfo(app)
    case "quit":
        guard let app = findRunningApp(s("app")) else { return ["quit": false, "running": false] }
        let name = app.localizedName ?? s("app")
        if Int(app.processIdentifier) == request["protectPid"] as? Int ?? -1 { throw HelperError("Not quitting \(name).") }
        app.terminate()
        let gone = waitUntil(request["wait"] as? Double ?? 3) { app.isTerminated }
        return ["quit": gone, "running": !gone, "name": name]
    case "window":
        return try windowAction(appName: s("app"), title: s("title"), action: s("action"))
    case "ax_find":
        return try axFind(appName: s("app"), text: s("text"), role: s("role"),
                          limit: request["limit"] as? Int ?? 20, includeMenus: request["menus"] as? Bool ?? true)
    case "ax_press":
        return try axPress(request["element"] as? Int ?? -1)
    case "ax_frame":
        guard let element = elementCache[request["element"] as? Int ?? -1] else { throw HelperError("That element is gone; search for it again.") }
        return ["frame": frame(element) ?? []]
    case "ripple":
        ripple(at: CGPoint(x: request["x"] as? Double ?? 0, y: request["y"] as? Double ?? 0))
        return ["shown": true]
    case "ax_set_value":
        return try axSetValue(request["element"] as? Int ?? -1, s("value"))
    case "type":
        try requireTrusted()
        typeText(s("text"))
        return ["typed": s("text").count]
    case "media":
        try pressMediaKey(s("key"))
        return ["pressed": s("key")]
    case "volume":
        return try volume(request)
    case "clipboard":
        return clipboard(request)
    case "open":
        let target = s("target")
        let url = target.contains("://") ? URL(string: target) : URL(fileURLWithPath: (target as NSString).expandingTildeInPath)
        guard let url else { throw HelperError("Not a valid address: \(target)") }
        if !url.isFileURL || FileManager.default.fileExists(atPath: url.path) {
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            if !s("app").isEmpty {
                guard let appURL = findAppURL(s("app")) else { throw HelperError("No app called \(s("app")) was found.") }
                NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: config)
            } else {
                NSWorkspace.shared.open(url, configuration: config)
            }
            return ["opened": url.isFileURL ? url.path : url.absoluteString]
        }
        throw HelperError("No such file or folder: \(url.path)")
    default:
        throw HelperError("Unknown command \(cmd).")
    }
}

// Read requests on a background thread; run them one at a time on the main thread (AppKit/AX)
Thread.detachNewThread {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        DispatchQueue.main.async {
            let id = request["id"] ?? NSNull()
            do {
                emit(["id": id, "ok": true, "result": try handle(request)])
            } catch let error as HelperError {
                emit(["id": id, "ok": false, "error": error.message])
            } catch {
                emit(["id": id, "ok": false, "error": error.localizedDescription])
            }
        }
    }
    exit(0) // VS Code went away
}
RunLoop.main.run()
