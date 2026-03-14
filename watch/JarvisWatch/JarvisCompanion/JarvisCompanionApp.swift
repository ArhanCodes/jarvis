import SwiftUI

@main
struct JarvisCompanionApp: App {
    init() {
        // Start the WatchConnectivity relay so the watch can send commands through us
        WatchRelay.shared.start()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .onOpenURL { url in
                    if url.scheme == "jarvis" && url.host == "talk" {
                        NotificationCenter.default.post(name: .jarvisStartRecording, object: nil)
                    }
                }
        }
    }
}

extension Notification.Name {
    static let jarvisStartRecording = Notification.Name("jarvisStartRecording")
}
