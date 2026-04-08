import Foundation
import Combine

/// Connects to JARVIS Mac server via WebSocket, sends commands, receives text responses.
class iOSConnectionManager: NSObject, ObservableObject, NetServiceBrowserDelegate, NetServiceDelegate {
    static let shared = iOSConnectionManager()

    @Published var isConnected = false
    @Published var currentState = "offline"
    @Published var lastCommand = ""
    @Published var responseText = ""

    // Audio callback — set by AudioPlayer
    var onAudioReceived: ((Data) -> Void)?
    var onAudioEnd: (() -> Void)?

    private enum ConnectionTarget: Equatable {
        case none
        case local(host: String, port: UInt16)
        case aim
    }

    private let bonjourType = "_jarvis._tcp."
    private let bonjourDomain = "local."

    private var webSocketTask: URLSessionWebSocketTask?
    private var reconnectTimer: Timer?
    private var pingTimer: Timer?
    private var fallbackTimer: Timer?
    private var session: URLSession?
    private var browser: NetServiceBrowser?
    private var resolvingService: NetService?
    private var currentTarget: ConnectionTarget = .none
    private var socketReady = false
    private var intentionallyStopped = false
    private var pendingMessages: [[String: Any]] = []

    private override init() {
        super.init()
        session = URLSession(configuration: .default)
    }

    // MARK: - Connection

    // AIM fallback address
    private let aimHost = "185.197.250.205"
    private let aimPort: UInt16 = 5225

    func start() {
        intentionallyStopped = false
        reconnectTimer?.invalidate()
        reconnectTimer = nil

        guard webSocketTask == nil, !socketReady else { return }
        startLocalDiscovery()
    }

    func stop() {
        intentionallyStopped = true
        stopDiscovery()
        reconnectTimer?.invalidate()
        reconnectTimer = nil
        disconnectSocket(markOffline: true)
    }

    // MARK: - WebSocket

    private func startLocalDiscovery() {
        stopDiscovery()
        currentTarget = .none

        let browser = NetServiceBrowser()
        self.browser = browser
        browser.delegate = self
        browser.searchForServices(ofType: bonjourType, inDomain: bonjourDomain)

        fallbackTimer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            guard !self.socketReady, self.webSocketTask == nil else { return }
            print("  [ios] Local JARVIS server not found, falling back to AIM")
            self.stopDiscovery()
            self.connectToAIM()
        }
    }

    private func stopDiscovery() {
        fallbackTimer?.invalidate()
        fallbackTimer = nil
        resolvingService?.stop()
        resolvingService?.delegate = nil
        resolvingService = nil
        browser?.stop()
        browser?.delegate = nil
        browser = nil
    }

    private func connectToLocal(host: String, port: UInt16) {
        if case let .local(currentHost, currentPort) = currentTarget,
           currentHost == host,
           currentPort == port,
           (webSocketTask != nil || socketReady) {
            return
        }

        currentTarget = .local(host: host, port: port)
        print("  [ios] Connecting to Mac JARVIS at \(host):\(port)")
        connect(host: host, port: port)
    }

    private func connectToAIM() {
        if currentTarget == .aim, (webSocketTask != nil || socketReady) {
            return
        }

        currentTarget = .aim
        print("  [ios] Connecting to AIM at \(aimHost):\(aimPort)")
        connect(host: aimHost, port: aimPort)
    }

    private func connect(host: String, port: UInt16) {
        disconnectSocket(markOffline: false)

        let urlStr = "ws://\(host):\(port)?device=phone&name=iPhone&id=jarvis-phone"
        guard let url = URL(string: urlStr) else { return }

        guard let task = session?.webSocketTask(with: url) else { return }
        webSocketTask = task
        task.resume()

        receiveMessage(for: task)
        startPing()

        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self = self else { return }
            guard self.webSocketTask === task, !self.socketReady else { return }

            switch self.currentTarget {
            case .local:
                print("  [ios] Local Mac connection timed out, trying AIM")
                self.disconnectSocket(markOffline: true)
                self.connectToAIM()
            case .aim, .none:
                self.scheduleReconnect()
            }
        }
    }

    private func disconnectSocket(markOffline: Bool) {
        pingTimer?.invalidate()
        pingTimer = nil
        fallbackTimer?.invalidate()
        fallbackTimer = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        socketReady = false

        if markOffline {
            DispatchQueue.main.async {
                self.isConnected = false
                self.currentState = "offline"
            }
        }
    }

    private func scheduleReconnect() {
        guard !intentionallyStopped else { return }

        disconnectSocket(markOffline: true)
        stopDiscovery()
        reconnectTimer?.invalidate()
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            self.reconnectTimer = nil
            self.startLocalDiscovery()
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

        sendJSON(msg)
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

        sendJSON(msg)
    }

    private func sendJSON(_ msg: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let str = String(data: data, encoding: .utf8) else { return }

        guard socketReady, webSocketTask != nil else {
            pendingMessages.append(msg)
            start()
            return
        }

        webSocketTask?.send(.string(str)) { [weak self] error in
            guard let self = self else { return }
            if error != nil {
                self.pendingMessages.insert(msg, at: 0)
                self.scheduleReconnect()
            }
        }
    }

    private func flushPendingMessages() {
        guard socketReady, !pendingMessages.isEmpty else { return }

        let queued = pendingMessages
        pendingMessages.removeAll()

        for msg in queued {
            sendJSON(msg)
        }
    }

    private func receiveMessage(for task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self = self else { return }
            guard self.webSocketTask === task else { return }

            switch result {
            case .success(let message):
                if !self.socketReady {
                    self.socketReady = true
                    let route = self.currentTarget == .aim ? "AIM" : "Mac"
                    print("  [ios] WebSocket connected via \(route)")

                    DispatchQueue.main.async {
                        self.isConnected = true
                        self.currentState = "idle"
                    }
                    self.flushPendingMessages()
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
                self.receiveMessage(for: task)

            case .failure(let error):
                print("  [ios] WebSocket receive failed: \(error.localizedDescription)")
                self.scheduleReconnect()
            }
        }
    }

    // MARK: - Bonjour

    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        if service.name != "JARVIS", resolvingService != nil {
            return
        }

        if resolvingService?.name == service.name {
            return
        }

        resolvingService?.stop()
        resolvingService?.delegate = nil
        resolvingService = service
        service.delegate = self
        service.resolve(withTimeout: 5)
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String : NSNumber]) {
        print("  [ios] Bonjour search failed: \(errorDict)")
        if !socketReady, webSocketTask == nil {
            connectToAIM()
        }
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        resolvingService = nil
        fallbackTimer?.invalidate()
        fallbackTimer = nil
        browser?.stop()
        browser = nil

        guard let hostName = sender.hostName, sender.port > 0 else {
            if !socketReady, webSocketTask == nil {
                connectToAIM()
            }
            return
        }

        let host = hostName.hasSuffix(".") ? String(hostName.dropLast()) : hostName
        connectToLocal(host: host, port: UInt16(sender.port))
    }

    func netService(_ sender: NetService, didNotResolve errorDict: [String : NSNumber]) {
        print("  [ios] Bonjour resolve failed: \(errorDict)")
        if resolvingService?.name == sender.name {
            resolvingService = nil
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
            self?.sendJSON(msg)
        }
    }
}
