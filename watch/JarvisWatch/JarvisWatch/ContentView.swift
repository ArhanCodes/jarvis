import SwiftUI

struct ContentView: View {
    @StateObject private var connection = WatchConnectionManager.shared
    @State private var dictationText = ""
    @State private var showTextInput = false
    @State private var showToggleConfirmation = false

    private let gold = Color(red: 1.0, green: 0.72, blue: 0.22)

    var body: some View {
        NavigationStack {
            GeometryReader { geo in
                ZStack {
                    Color.black.ignoresSafeArea()

                    VStack(spacing: 6) {
                        // Connection indicator — moved to top
                        HStack(spacing: 4) {
                            Circle()
                                .fill(connection.isConnected ? Color.green : Color.red)
                                .frame(width: 6, height: 6)
                            Text(connection.isConnected ? "iPhone Linked" : "iPhone Offline")
                                .font(.system(size: 9))
                                .foregroundColor(.white.opacity(0.5))
                        }
                        .padding(.top, 2)

                        Spacer()

                        // Arc Reactor — tap to talk, double tap to toggle target
                        ArcReactorWatchView(
                            state: connection.currentState,
                            size: min(geo.size.width, geo.size.height) * 0.48
                        )
                        .onTapGesture(count: 2) {
                            connection.toggleResponseTarget()
                            showToggleConfirmation = true
                            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                                showToggleConfirmation = false
                            }
                        }
                        .onTapGesture(count: 1) {
                            showTextInput = true
                        }

                        // Response target indicator
                        HStack(spacing: 4) {
                            Image(systemName: connection.respondOnMac ? "desktopcomputer" : "iphone")
                                .font(.system(size: 9))
                            Text(connection.respondOnMac ? "MAC" : "PHONE")
                                .font(.system(size: 9, weight: .bold, design: .monospaced))
                        }
                        .foregroundColor(gold.opacity(0.6))

                        // State label
                        Text(stateLabel)
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundColor(stateColor)
                            .tracking(1.5)

                        // Toggle confirmation or sent confirmation
                        if showToggleConfirmation {
                            Text(connection.respondOnMac ? "Responding on Mac" : "Responding on Phone")
                                .font(.system(size: 10, weight: .medium))
                                .foregroundColor(gold.opacity(0.9))
                                .transition(.opacity)
                        } else if !connection.lastSentConfirmation.isEmpty {
                            Text(connection.lastSentConfirmation)
                                .font(.system(size: 10, weight: .medium))
                                .foregroundColor(gold.opacity(0.8))
                                .multilineTextAlignment(.center)
                                .lineLimit(2)
                                .padding(.horizontal, 8)
                        }

                        Spacer()

                        // Mic button
                        Button(action: { showTextInput = true }) {
                            ZStack {
                                Circle()
                                    .fill(connection.isConnected ? gold : Color.gray.opacity(0.3))
                                    .frame(width: 40, height: 40)
                                Image(systemName: "mic.fill")
                                    .font(.system(size: 16))
                                    .foregroundColor(.white)
                            }
                        }
                        .buttonStyle(.plain)
                        .padding(.bottom, 2)
                    }
                }
            }
            .navigationDestination(isPresented: $showTextInput) {
                VStack(spacing: 16) {
                    Text("JARVIS")
                        .font(.system(size: 14, weight: .bold, design: .monospaced))
                        .foregroundColor(gold)

                    // Show where response will go
                    HStack(spacing: 4) {
                        Image(systemName: connection.respondOnMac ? "desktopcomputer" : "iphone")
                            .font(.system(size: 10))
                        Text(connection.respondOnMac ? "→ Mac" : "→ Phone")
                            .font(.system(size: 10, design: .monospaced))
                    }
                    .foregroundColor(gold.opacity(0.5))

                    TextField("Tap to speak...", text: $dictationText)
                        .multilineTextAlignment(.center)

                    Button(action: sendAndDismiss) {
                        HStack {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.system(size: 20))
                            Text("Send")
                                .font(.system(size: 15, weight: .semibold))
                        }
                        .foregroundColor(.black)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(gold)
                        .cornerRadius(20)
                    }
                    .buttonStyle(.plain)
                    .disabled(dictationText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .opacity(dictationText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1.0)
                }
                .padding()
            }
        }
        .onAppear {
            connection.start()
        }
    }

    private var stateLabel: String {
        switch connection.currentState {
        case "processing": return "PROCESSING"
        case "speaking": return "RESPONDING"
        case "idle": return connection.isConnected ? "STANDING BY" : "OFFLINE"
        default: return connection.isConnected ? "ONLINE" : "OFFLINE"
        }
    }

    private var stateColor: Color {
        switch connection.currentState {
        case "activated": return Color(red: 1.0, green: 0.82, blue: 0.3)
        case "processing": return Color(red: 1.0, green: 0.85, blue: 0.4)
        case "speaking": return Color(red: 1.0, green: 0.72, blue: 0.22)
        case "idle": return Color(red: 0.8, green: 0.58, blue: 0.15)
        default: return Color(red: 0.4, green: 0.3, blue: 0.15)
        }
    }

    private func sendAndDismiss() {
        let text = dictationText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        var command = text
        if let range = command.range(of: "^\\s*jarvis[,.]?\\s*", options: [.regularExpression, .caseInsensitive]) {
            command = String(command[range.upperBound...])
        }
        guard !command.isEmpty else { return }

        connection.sendCommand(command)
        dictationText = ""
        showTextInput = false
    }
}

#Preview {
    ContentView()
}
