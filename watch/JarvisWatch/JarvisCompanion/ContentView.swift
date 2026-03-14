import SwiftUI
import Speech
import AVFoundation

struct ContentView: View {
    @StateObject private var connection = iOSConnectionManager.shared
    @State private var isRecording = false
    @State private var transcribedText = ""
    @State private var speechAuthorized = false

    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    @State private var recognitionTask: SFSpeechRecognitionTask?
    @State private var audioEngine = AVAudioEngine()
    @State private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    @State private var silenceTimer: Timer?
    private let audioPlayer = iOSAudioPlayer.shared

    private let gold = Color(red: 1.0, green: 0.72, blue: 0.22)

    var body: some View {
        ZStack {
            // Fullscreen energy orb as background
            EnergyOrbView(
                currentState: connection.currentState,
                isRecording: isRecording
            )

            // UI overlay
            VStack(spacing: 0) {
                Spacer()

                // State label
                Text(stateLabel)
                    .font(.system(size: 14, weight: .medium, design: .monospaced))
                    .foregroundColor(gold.opacity(0.7))
                    .tracking(3)
                    .padding(.bottom, 12)

                // Response or transcription text
                if !connection.responseText.isEmpty {
                    ScrollViewReader { proxy in
                        ScrollView {
                            Text(connection.responseText)
                                .font(.system(size: 15))
                                .foregroundColor(.white.opacity(0.85))
                                .multilineTextAlignment(.leading)
                                .padding(.horizontal, 24)
                                .id("response")
                        }
                        .frame(maxHeight: 180)
                        .onChange(of: connection.responseText) { _ in
                            proxy.scrollTo("response", anchor: .bottom)
                        }
                    }
                    .padding(.bottom, 12)
                } else if isRecording && !transcribedText.isEmpty {
                    Text(transcribedText)
                        .font(.system(size: 15))
                        .foregroundColor(gold.opacity(0.9))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                        .padding(.bottom, 12)
                }

                // Mic button
                Button(action: toggleRecording) {
                    ZStack {
                        Circle()
                            .fill(isRecording ? Color.red.opacity(0.8) : gold.opacity(connection.isConnected ? 0.3 : 0.1))
                            .frame(width: 64, height: 64)

                        if isRecording {
                            RoundedRectangle(cornerRadius: 4)
                                .fill(Color.white)
                                .frame(width: 22, height: 22)
                        } else {
                            Image(systemName: "mic.fill")
                                .font(.system(size: 24))
                                .foregroundColor(connection.isConnected ? .white : .white.opacity(0.3))
                        }
                    }
                }
                .buttonStyle(.plain)
                .disabled(!connection.isConnected)
                .padding(.bottom, 16)

                // Connection status
                HStack(spacing: 6) {
                    Circle()
                        .fill(connection.isConnected ? Color.green : Color.red)
                        .frame(width: 6, height: 6)
                    Text(connection.isConnected ? "Connected" : "Offline")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(.white.opacity(0.4))
                }
                .padding(.bottom, 30)
            }
        }
        .onAppear {
            requestSpeechAuth()
            connection.start()
        }
        .onDisappear {
            connection.stop()
        }
        .onReceive(NotificationCenter.default.publisher(for: .jarvisStartRecording)) { _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                if connection.isConnected && speechAuthorized && !isRecording {
                    startRecording()
                }
            }
        }
    }

    // MARK: - Computed

    private var stateLabel: String {
        if isRecording { return "LISTENING" }
        switch connection.currentState {
        case "processing": return "PROCESSING"
        case "speaking": return "SPEAKING"
        case "idle": return connection.isConnected ? "STANDING BY" : "OFFLINE"
        default: return connection.isConnected ? "ONLINE" : "OFFLINE"
        }
    }

    // MARK: - Speech

    private func requestSpeechAuth() {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                speechAuthorized = status == .authorized
            }
        }
    }

    private func toggleRecording() {
        if isRecording {
            stopRecording()
        } else {
            startRecording()
        }
    }

    private func startRecording() {
        guard speechAuthorized, !isRecording else { return }

        transcribedText = ""
        connection.responseText = ""
        audioPlayer.stop()

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        recognitionRequest = request

        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker])
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            return
        }

        let inputNode = audioEngine.inputNode
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputNode.outputFormat(forBus: 0)) { buffer, _ in
            request.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            inputNode.removeTap(onBus: 0)
            return
        }

        recognitionTask = speechRecognizer?.recognitionTask(with: request) { result, error in
            if let result = result {
                DispatchQueue.main.async {
                    transcribedText = result.bestTranscription.formattedString
                    resetSilenceTimer()
                }
                if result.isFinal {
                    DispatchQueue.main.async {
                        sendAndStop()
                    }
                }
            }
            if error != nil {
                DispatchQueue.main.async {
                    sendAndStop()
                }
            }
        }

        isRecording = true
        resetSilenceTimer()
    }

    private func resetSilenceTimer() {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: false) { _ in
            DispatchQueue.main.async {
                sendAndStop()
            }
        }
    }

    private func sendAndStop() {
        silenceTimer?.invalidate()
        silenceTimer = nil

        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil

        isRecording = false

        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch { }

        let text = transcribedText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty {
            var command = text
            if let range = command.range(of: "^\\s*jarvis[,.]?\\s*", options: [.regularExpression, .caseInsensitive]) {
                command = String(command[range.upperBound...])
            }
            if !command.isEmpty {
                connection.sendCommand(command)
            }
        }
    }

    private func stopRecording() {
        sendAndStop()
    }
}
