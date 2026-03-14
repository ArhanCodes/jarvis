import Foundation
import WatchConnectivity

/// Sends commands to JARVIS via the iPhone app using WatchConnectivity.
/// The iPhone relays commands to the Mac JARVIS server over WebSocket.
/// This avoids direct WebSocket on watchOS which crashes due to memory limits.
class WatchConnectionManager: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = WatchConnectionManager()

    @Published var isConnected = false
    @Published var currentState = "idle"
    @Published var lastCommand = ""
    @Published var responseText = ""
    @Published var lastSentConfirmation = ""
    @Published var respondOnMac = false  // false = respond on phone, true = respond on mac

    private var wcSession: WCSession?

    override private init() {
        super.init()
    }

    func start() {
        guard WCSession.isSupported() else { return }
        wcSession = WCSession.default
        wcSession?.delegate = self
        wcSession?.activate()
    }

    func stop() {
        // WCSession stays active for the app lifetime
    }

    func toggleResponseTarget() {
        respondOnMac.toggle()
    }

    func sendCommand(_ text: String) {
        guard let session = wcSession, session.isReachable else {
            DispatchQueue.main.async {
                self.lastSentConfirmation = "iPhone not reachable"
                self.clearConfirmation()
            }
            return
        }

        let message: [String: Any] = [
            "type": "jarvis_command",
            "text": text,
            "respondOnMac": respondOnMac
        ]

        DispatchQueue.main.async {
            self.currentState = "processing"
        }

        let target = respondOnMac ? "Mac" : "Phone"
        session.sendMessage(message, replyHandler: { reply in
            DispatchQueue.main.async {
                if let status = reply["status"] as? String, status == "sent" {
                    let preview = text.count > 25 ? String(text.prefix(22)) + "..." : text
                    self.lastSentConfirmation = "→ \(target): \"\(preview)\""
                } else {
                    self.lastSentConfirmation = "Sent to \(target)"
                }
                self.clearConfirmation()
            }
        }, errorHandler: { error in
            DispatchQueue.main.async {
                self.lastSentConfirmation = "Failed to send"
                self.currentState = "idle"
                self.clearConfirmation()
            }
        })
    }

    private func clearConfirmation() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            self.lastSentConfirmation = ""
        }
    }

    // MARK: - WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async {
            self.isConnected = session.isReachable
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        DispatchQueue.main.async {
            self.isConnected = session.isReachable
        }
    }

    // Receive status updates from iPhone
    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        DispatchQueue.main.async {
            if let state = message["state"] as? String {
                self.currentState = state
            }
        }
    }
}
