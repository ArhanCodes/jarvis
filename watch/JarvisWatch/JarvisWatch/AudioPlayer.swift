import Foundation

/// Audio playback disabled on watchOS — responses shown as text only.
/// AVAudioPlayer with MP3 data crashes on watchOS due to memory/format issues.
class AudioPlayer: ObservableObject {
    @Published var isPlaying = false

    func enqueue(_ audioData: Data) {
        // No-op: audio playback disabled on watchOS to prevent crashes
    }

    func finishQueue() {
        // No-op
    }

    func stop() {
        DispatchQueue.main.async {
            self.isPlaying = false
        }
    }
}
