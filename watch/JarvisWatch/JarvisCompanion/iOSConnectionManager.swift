import Foundation
import Combine

/// Connects to JARVIS Mac server via WebSocket, sends commands, receives text responses.
class iOSConnectionManager: ObservableObject {
    static let shared = iOSConnectionManager()

    @Published var isConnected = false
    @Published var currentState = "offline"
    @Published var lastCommand = ""
    @Published var responseText = ""

    // Audio callback — set by AudioPlayer
    var onAudioReceived: ((Data) -> Void)?
    var onAudioEnd: (() -> Void)?

    private var webSocketTask: URLSessionWebSocketTask?
    private var reconnectTimer: Timer?
    private var pingTimer: Timer?
    private var session: URLSession?

    private init() {
        session = URLSession(configuration: .default)
    }

    // MARK: - Connection

    // VPS address — JARVIS is always on at this address via AIM
    private let vpsHost = "185.197.250.205"
    private let vpsPort: UInt16 = 5225

    func start() {
        // Connect directly to VPS — no Bonjour discovery needed
        connect(host: vpsHost, port: vpsPort)
    }

    func stop() {
        disconnect()
    }

    // MARK: - WebSocket

    private func connect(host: String, port: UInt16) {
        guard webSocketTask == nil || !isConnected else { return }
        disconnect()

        let urlStr = "ws://\(host):\(port)?device=phone&name=iPhone&id=jarvis-phone"
        guard let url = URL(string: urlStr) else { return }

        webSocketTask = session?.webSocketTask(with: url)
        webSocketTask?.resume()

        receiveMessage()
        startPing()

        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self = self, !self.isConnected else { return }
            self.scheduleReconnect()
        }
    }

    func disconnect() {
        pingTimer?.invalidate()
        pingTimer = nil
        reconnectTimer?.invalidate()
        reconnectTimer = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        DispatchQueue.main.async {
            self.isConnected = false
            self.currentState = "offline"
        }
    }

    private func scheduleReconnect() {
        disconnect()
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            self.connect(host: self.vpsHost, port: self.vpsPort)
        }
    }

    // MARK: - Send / Receive

    func sendCommand(_ text: String) {
        let requestId = "req-\(Int(Date().timeIntervalSince1970 * 1000))"
        let msg: [String: Any] = [
            "type": "command",
            "text": text,
            "requestId": requestId,
            "noAudio": false,
        ]

        DispatchQueue.main.async {
            self.responseText = ""
            self.currentState = "processing"
        }

        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let str = String(data: data, encoding: .utf8) else { return }

        webSocketTask?.send(.string(str)) { [weak self] error in
            if error != nil {
                self?.scheduleReconnect()
            }
        }
    }

    /// Send command that should be answered on the Mac (not the phone).
    /// Uses playOnMac: true so the server plays TTS on Mac speakers directly.
    func sendCommandForMac(_ text: String) {
        let requestId = "req-\(Int(Date().timeIntervalSince1970 * 1000))"
        let msg: [String: Any] = [
            "type": "command",
            "text": text,
            "requestId": requestId,
            "noAudio": true,
            "playOnMac": true,
        ]

        DispatchQueue.main.async {
            self.currentState = "processing"
        }

        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let str = String(data: data, encoding: .utf8) else { return }

        webSocketTask?.send(.string(str)) { [weak self] error in
            if error != nil {
                self?.scheduleReconnect()
            }
        }
    }

    private func receiveMessage() {
        webSocketTask?.receive { [weak self] result in
            guard let self = self else { return }

            switch result {
            case .success(let message):
                if !self.isConnected {
                    DispatchQueue.main.async {
                        self.isConnected = true
                        self.currentState = "idle"
                    }
                }

                switch message {
                case .string(let text):
                    self.handleMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.handleMessage(text)
                    }
                @unknown default:
                    break
                }
                self.receiveMessage()

            case .failure(_):
                self.scheduleReconnect()
            }
        }
    }

    private var tokenBuffer = ""
    private var tokenFlushScheduled = false

    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        switch type {
        case "status":
            DispatchQueue.main.async {
                if let state = json["state"] as? String {
                    self.currentState = state
                }
                if let cmd = json["lastCommand"] as? String, !cmd.isEmpty {
                    self.lastCommand = cmd
                }
            }

        case "token":
            if let token = json["text"] as? String {
                DispatchQueue.main.async {
                    self.tokenBuffer += token
                    if !self.tokenFlushScheduled {
                        self.tokenFlushScheduled = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                            self.responseText += self.tokenBuffer
                            self.tokenBuffer = ""
                            self.tokenFlushScheduled = false
                        }
                    }
                }
            }

        case "audio":
            if let b64 = json["data"] as? String,
               let audioData = Data(base64Encoded: b64) {
                onAudioReceived?(audioData)
            }

        case "audioEnd":
            onAudioEnd?()

        case "error":
            DispatchQueue.main.async {
                self.currentState = "idle"
                if let msg = json["message"] as? String {
                    self.responseText = "Error: \(msg)"
                }
            }

        case "pong":
            break

        default:
            break
        }
    }

    private func startPing() {
        pingTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            let msg: [String: String] = ["type": "ping"]
            guard let data = try? JSONSerialization.data(withJSONObject: msg),
                  let str = String(data: data, encoding: .utf8) else { return }
            self?.webSocketTask?.send(.string(str)) { _ in }
        }
    }
}
