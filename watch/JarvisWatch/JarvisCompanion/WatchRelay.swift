import Foundation
import WatchConnectivity

/// Receives commands from the Apple Watch via WatchConnectivity
/// and relays them to JARVIS on the Mac via the existing WebSocket connection.
class WatchRelay: NSObject, WCSessionDelegate {
    static let shared = WatchRelay()

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

    /// Forward JARVIS state changes to the watch
    func sendStateToWatch(_ state: String) {
        guard let session = wcSession, session.isReachable else { return }
        session.sendMessage(["state": state], replyHandler: nil, errorHandler: nil)
    }

    // MARK: - WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        // Ready
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    // Receive command from watch and relay to JARVIS
    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        guard let type = message["type"] as? String, type == "jarvis_command",
              let text = message["text"] as? String else {
            replyHandler(["status": "error", "message": "Invalid message"])
            return
        }

        let respondOnMac = message["respondOnMac"] as? Bool ?? false

        if respondOnMac {
            // Send to Mac with noAudio: true — Mac handles the response itself
            iOSConnectionManager.shared.sendCommandForMac(text)
        } else {
            // Send normally — iPhone gets the response (text + audio)
            iOSConnectionManager.shared.sendCommand(text)
        }

        replyHandler(["status": "sent"])
    }
}
