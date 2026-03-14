import Foundation

/// Lightweight command handler for watchOS.
/// Instead of AVAudioEngine (which crashes on watchOS due to memory),
/// we use the native watchOS dictation via TextField.
class SpeechRecognizer: ObservableObject {
    @Published var isRecording = false
    @Published var transcribedText = ""
    @Published var isAuthorized = true  // Always true — we use system dictation

    var onCommandReady: ((String) -> Void)?

    func sendCommand(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        // Strip "jarvis" prefix if present
        var command = trimmed
        if let range = command.range(of: "^\\s*jarvis[,.]?\\s*", options: [.regularExpression, .caseInsensitive]) {
            command = String(command[range.upperBound...])
        }

        if !command.isEmpty {
            transcribedText = command
            onCommandReady?(command)
        }
    }
}
