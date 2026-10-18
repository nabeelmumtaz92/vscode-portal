// Siri and Shortcuts for VSCode Portal, without opening the app:
//   "Ask <app>"                  → "What should your Mac do?", runs it as a Mac-mode chat, reads back the reply (with a picture)
//   "Show my Mac's screen in <app>" → a current screenshot
// Both connect the same way the app does: through the relay, end-to-end encrypted with the pairing key from the
// Keychain (saved by App.tsx). This file mirrors extension/web/e2e.js; keep the two in step.

import AppIntents
import CryptoKit
import Foundation
import SwiftUI
import UIKit

// MARK: - Pairing and end-to-end encryption

struct PortalError: LocalizedError {
  let message: String
  init(_ m: String) { message = m }
  var errorDescription: String? { message }
}

struct Pairing: Decodable { let relay: String; let key: String; let room: String }

enum PortalPairing {
  static let service = "com.nabeelmumtaz.vscodeportal.pairing"
  static func load() throws -> Pairing {
    let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service,
                                  kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data,
          let pairing = try? JSONDecoder().decode(Pairing.self, from: data) else {
      throw PortalError("Open the app and scan the QR code in VS Code first.")
    }
    return pairing
  }
}

func base64url(_ s: String) -> Data? {
  var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  while b.count % 4 != 0 { b += "=" }
  return Data(base64Encoded: b)
}
func hex(_ d: some Sequence<UInt8>) -> String { d.map { String(format: "%02x", $0) }.joined() }

struct RoomKeys {
  let c2h: SymmetricKey, h2c: SymmetricKey, label: SymmetricKey, clientProof: String
  init(pairingKey: String) throws {
    guard let raw = base64url(pairingKey), raw.count == 32 else { throw PortalError("The pairing key isn't valid. Scan the QR code again.") }
    let ikm = SymmetricKey(data: raw)
    func derive(_ info: String) -> SymmetricKey {
      HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: Data(), info: Data(info.utf8), outputByteCount: 32)
    }
    c2h = derive("vsp c2h"); h2c = derive("vsp h2c"); label = derive("vsp label")
    clientProof = derive("vsp client proof").withUnsafeBytes { hex($0) }
  }
}

/// One direction of messages: AES-256-GCM, [12-byte nonce][ciphertext][tag] in base64, with a strict counter
final class Channel {
  private let sendKey: SymmetricKey, recvKey: SymmetricKey
  private var sent = 0, received = 0
  init(send: SymmetricKey, receive: SymmetricKey) { sendKey = send; recvKey = receive }

  func seal(_ text: String) throws -> String {
    sent += 1
    let plain = try JSONSerialization.data(withJSONObject: ["q": sent, "m": text])
    let box = try AES.GCM.seal(plain, using: sendKey)
    return box.combined!.base64EncodedString()
  }
  /// The decrypted text, or nil for a binary message (screen video, not used here)
  func open(_ b64: String) throws -> String? {
    guard let data = Data(base64Encoded: b64) else { throw PortalError("Bad message") }
    let plain = try AES.GCM.open(try AES.GCM.SealedBox(combined: data), using: recvKey)
    if plain.first == 0 { received += 1; return nil } // binary (counter checked by the page, not needed here)
    guard let obj = try JSONSerialization.jsonObject(with: plain) as? [String: Any],
          let q = obj["q"] as? Int, let m = obj["m"] as? String else { throw PortalError("Bad message") }
    guard q == received + 1 else { throw PortalError("Message out of order") }
    received = q
    return m
  }
}

func openLabel(_ b64: String, key: SymmetricKey) -> [String: Any]? {
  guard let data = Data(base64Encoded: b64), let box = try? AES.GCM.SealedBox(combined: data),
        let plain = try? AES.GCM.open(box, using: key) else { return nil }
  return try? JSONSerialization.jsonObject(with: plain) as? [String: Any]
}

// MARK: - A connection to one computer

final class PortalConnection {
  private let task: URLSessionWebSocketTask
  private let channel: Channel
  private var nextId = 0
  private var waiting: [Int: CheckedContinuation<Any?, Error>] = [:]
  private var events: AsyncStream<[String: Any]>.Continuation?
  let eventStream: AsyncStream<[String: Any]>
  private let lock = NSLock()

  /// Connects to the window the app last used, preferring one that's always on
  static func connect() async throws -> PortalConnection {
    let pairing = try PortalPairing.load()
    let keys = try RoomKeys(pairingKey: pairing.key)
    var hostsURL = URLComponents(string: "\(pairing.relay)/hosts")!
    hostsURL.queryItems = [.init(name: "room", value: pairing.room), .init(name: "proof", value: keys.clientProof)]
    let (data, response) = try await URLSession.shared.data(from: hostsURL.url!)
    if (response as? HTTPURLResponse)?.statusCode == 404 { throw PortalError("This phone isn't paired anymore. Scan the QR code in VS Code again.") }
    let hosts = (try JSONSerialization.jsonObject(with: data) as? [[String: Any]] ?? []).compactMap { h -> (String, String)? in
      guard let id = h["id"] as? String else { return nil }
      let name = (h["label"] as? String).flatMap { openLabel($0, key: keys.label) }?["name"] as? String ?? ""
      return (id, name)
    }
    guard !hosts.isEmpty else { throw PortalError("Your Mac is offline. Open VS Code on it, or turn on Keep Running When VS Code Is Closed.") }
    let saved = UserDefaults.standard.string(forKey: "portalHost")
    let host = hosts.first { $0.1.hasSuffix("(always on)") } ?? hosts.first { $0.0 == saved } ?? hosts[0]

    var wsURL = URLComponents(string: pairing.relay.replacingOccurrences(of: "http", with: "ws", options: .anchored) + "/c")!
    wsURL.queryItems = [.init(name: "room", value: pairing.room), .init(name: "proof", value: keys.clientProof), .init(name: "host", value: host.0)]
    let conn = PortalConnection(task: URLSession.shared.webSocketTask(with: wsURL.url!), channel: Channel(send: keys.c2h, receive: keys.h2c))
    try await conn.start()
    return conn
  }

  private init(task: URLSessionWebSocketTask, channel: Channel) {
    self.task = task; self.channel = channel
    var cont: AsyncStream<[String: Any]>.Continuation?
    eventStream = AsyncStream { cont = $0 }
    events = cont
  }

  private func start() async throws {
    task.resume()
    receiveLoop()
    // The computer says hello first ("ready")
    for await e in eventStream where e["type"] as? String == "ready" { return }
    throw PortalError("Couldn't reach your Mac.")
  }

  private func receiveLoop() {
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .failure:
        self.lock.lock(); let w = self.waiting; self.waiting = [:]; self.lock.unlock()
        for c in w.values { c.resume(throwing: PortalError("The connection to your Mac dropped.")) }
        self.events?.finish()
      case .success(let message):
        if case .string(let s) = message, let text = try? self.channel.open(s),
           let obj = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] {
          if let id = obj["id"] as? Int {
            self.lock.lock(); let c = self.waiting.removeValue(forKey: id); self.lock.unlock()
            if obj["ok"] as? Bool == true { c?.resume(returning: obj["result"]) }
            else { c?.resume(throwing: PortalError(obj["error"] as? String ?? "Something went wrong on the Mac.")) }
          } else {
            self.events?.yield(obj)
          }
        }
        self.receiveLoop()
      }
    }
  }

  func call(_ type: String, _ args: [String: Any] = [:]) async throws -> Any? {
    lock.lock(); nextId += 1; let id = nextId; lock.unlock()
    var msg = args; msg["id"] = id; msg["type"] = type
    let text = String(data: try JSONSerialization.data(withJSONObject: msg), encoding: .utf8)!
    let sealed = try channel.seal(text)
    return try await withCheckedThrowingContinuation { cont in
      lock.lock(); waiting[id] = cont; lock.unlock()
      task.send(.string(sealed)) { error in
        if let error {
          self.lock.lock(); let c = self.waiting.removeValue(forKey: id); self.lock.unlock()
          c?.resume(throwing: error)
        }
      }
    }
  }

  func close() { task.cancel(with: .normalClosure, reason: nil) }
}

// MARK: - What the Mac did

struct TaskOutcome { var reply = ""; var image: UIImage?; var error: String? }

/// Sends a request to the Mac agent and waits for it to finish (up to 10 minutes)
func runOnMac(_ request: String) async throws -> TaskOutcome {
  let conn = try await PortalConnection.connect()
  defer { conn.close() }
  guard let chat = (try await conn.call("chat.new") as? [String: Any])?["chat"] as? String else { throw PortalError("Couldn't start a chat.") }
  _ = try await conn.call("prompt", ["chat": chat, "text": request, "mode": "mac"])
  var outcome = TaskOutcome()
  let deadline = Date().addingTimeInterval(600)
  for await m in conn.eventStream {
    if Date() > deadline { outcome.error = "Still working on it; check the app."; break }
    guard m["chat"] as? String == chat else { continue }
    if m["type"] as? String == "chat.status", m["running"] as? Bool == false { break }
    guard m["type"] as? String == "chat.event", let e = m["event"] as? [String: Any] else { continue }
    switch e["type"] as? String {
    case "assistant":
      let blocks = (e["message"] as? [String: Any])?["content"] as? [[String: Any]] ?? []
      let text = blocks.filter { $0["type"] as? String == "text" }.compactMap { $0["text"] as? String }.joined(separator: "\n")
      if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { outcome.reply = text }
    case "portal.image":
      if let b64 = e["image"] as? String, let data = Data(base64Encoded: b64), let img = UIImage(data: data) { outcome.image = img }
    case "portal.error":
      outcome.error = e["text"] as? String
    case "portal.approve":
      outcome.error = "Claude is waiting for your OK on a Terminal command. Open the app to allow or deny it."
      return outcome
    default: break
    }
  }
  return outcome
}

// MARK: - Intents

struct PictureView: View {
  let image: UIImage
  var body: some View { Image(uiImage: image).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 10)) }
}

struct AskPortalIntent: AppIntent {
  static let title: LocalizedStringResource = "Ask your computer"
  static let description = IntentDescription("Tell your computer what to do. Claude does it and tells you what happened.")

  @Parameter(title: "Request", requestValueDialog: IntentDialog("What should your computer do?"))
  var request: String

  func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog & ShowsSnippetView {
    let outcome = try await runOnMac(request)
    let text = outcome.error ?? (outcome.reply.isEmpty ? "Done." : outcome.reply)
    let spoken = String(text.replacingOccurrences(of: "**", with: "").prefix(600))
    if let image = outcome.image {
      return .result(value: text, dialog: IntentDialog(stringLiteral: spoken), view: AnyView(PictureView(image: image)))
    }
    return .result(value: text, dialog: IntentDialog(stringLiteral: spoken), view: AnyView(EmptyView()))
  }
}

struct ShowScreenIntent: AppIntent {
  static let title: LocalizedStringResource = "Show my computer screen"
  static let description = IntentDescription("A picture of your computer screen right now.")

  func perform() async throws -> some IntentResult & ReturnsValue<IntentFile> & ShowsSnippetView {
    let conn = try await PortalConnection.connect()
    defer { conn.close() }
    guard let shot = try await conn.call("screen.snapshot") as? [String: Any], let b64 = shot["data"] as? String,
          let data = Data(base64Encoded: b64), let image = UIImage(data: data) else { throw PortalError("Couldn't get a picture of the screen.") }
    let file = IntentFile(data: data, filename: "computer screen.jpg", type: .jpeg)
    return .result(value: file, view: AnyView(PictureView(image: image)))
  }
}

struct PortalShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(intent: AskPortalIntent(), phrases: ["Ask \(.applicationName)", "Ask \(.applicationName) to do something",
                                                     "Tell my computer with \(.applicationName)"],
                shortTitle: "Ask your computer", systemImageName: "sparkles")
    AppShortcut(intent: ShowScreenIntent(), phrases: ["Show my computer screen in \(.applicationName)", "Show my computer with \(.applicationName)"],
                shortTitle: "Show computer screen", systemImageName: "display")
  }
}

// MARK: - Testing on the Simulator: launch with -testAsk "<request>" or -testScreen YES; results go to the log

enum IntentSelfTest {
  static func runIfAsked() {
    let defaults = UserDefaults.standard
    if let request = defaults.string(forKey: "testAsk") {
      Task {
        try? await Task.sleep(nanoseconds: 6_000_000_000) // let the app save a pairing passed at launch
        do { let o = try await runOnMac(request); NSLog("PORTAL-TEST ask: %@ | image: %@ | error: %@", o.reply, o.image == nil ? "no" : "yes", o.error ?? "none") }
        catch { NSLog("PORTAL-TEST ask failed: %@", error.localizedDescription) }
      }
    }
    if defaults.bool(forKey: "testScreen") {
      Task {
        try? await Task.sleep(nanoseconds: 6_000_000_000)
        do {
          let conn = try await PortalConnection.connect(); defer { conn.close() }
          let shot = try await conn.call("screen.snapshot") as? [String: Any]
          NSLog("PORTAL-TEST screen: %@x%@", "\(shot?["width"] ?? 0)", "\(shot?["height"] ?? 0)")
        } catch { NSLog("PORTAL-TEST screen failed: %@", error.localizedDescription) }
      }
    }
  }
}
